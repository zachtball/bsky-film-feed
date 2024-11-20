import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import { AppContext } from '../config'
import { BskyAgent } from '@atproto/api'
import { log } from 'console-log-colors'
import OpenAI from 'openai'
import { zodResponseFormat } from 'openai/helpers/zod'
import { z } from 'zod'
import dotenv from 'dotenv'
dotenv.config()

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

// max 15 chars
export const shortname = 'hot'

let intervalsScheduled = false

function calculateScore(timeInHours: number, likes: number) {
  // Hacker News algorithm
  return likes / Math.pow(timeInHours + 2, 2.8)
}

/**
 * Go through the database and calculate scores for each post
 */
async function refreshScores(ctx: AppContext, agent: BskyAgent) {
  const MINUTE = 1000 * 60
  const HOUR = 60 * MINUTE
  const REFRESH_INTERVALS = [
    [5 * MINUTE, 5 * MINUTE], // Refresh posts < 5 minutes old every 5 minutes
    [10 * MINUTE, 10 * MINUTE], // Refresh posts < 10 minutes old every 10 minutes
    [15 * MINUTE, 15 * MINUTE], // Refresh posts < 15 minutes old every 15 minutes
    [2 * HOUR, 30 * MINUTE], // Refresh posts < 2 hours old every 30 minutes
    [6 * HOUR, 1 * HOUR], // Refresh posts < 6 hours old every hour
    [12 * HOUR, 2 * HOUR], // Refresh posts < 12 hours old every 2 hours
    [24 * HOUR, 4 * HOUR], // Refresh posts < 24 hours old every 4 hours
    [48 * HOUR, 8 * HOUR], // Refresh posts < 48 hours old every 8 hours
  ]
  const currentTime = Date.now()

  let builder = ctx.db.selectFrom('post').selectAll()

  for (const interval of REFRESH_INTERVALS) {
    const [time, delay] = interval

    builder = builder.where((eb) =>
      eb.or([
        eb('first_indexed', '>', currentTime - time),
        eb('last_scored', '<', currentTime - delay),
      ]),
    )
  }

  builder.orderBy('first_indexed', 'desc')

  const res = await builder.execute()

  for (const row of res) {
    // console.dir(row);
    let errorStatus = 0
    const post = await agent
      .getPostThread({
        uri: row.uri,
        depth: 1,
      })
      .catch((err) => {
        console.error(err)
        errorStatus = err.status
        return null
      })
    if (post == null) {
      // console.error("Failed to get post, deleting: " + row.uri);
      // await deletePost(ctx, row.uri);
      continue
    }
    const likeCount = ((<any>post.data.thread.post)?.likeCount as number) ?? 0
    const repostCount =
      ((<any>post.data.thread.post)?.repostCount as number) ?? 0
    const indexedTime = row.first_indexed
    const score = calculateScore(
      (currentTime - indexedTime) / 1000 / 60 / 60,
      likeCount + repostCount + row.mod,
    )
    // console.log("Updating score for post: " + row.uri + " to " + score);
    await ctx.db
      .insertInto('post')
      .values({
        uri: row.uri,
        cid: row.cid,
        first_indexed: indexedTime,
        score: score,
        last_scored: currentTime,
        mod: row.mod,
        needs_eval: row.needs_eval,
      })
      .onConflict((oc) =>
        oc.doUpdateSet({
          score: score,
          last_scored: currentTime,
        }),
      )
      .execute()
  }
  // logPosts(ctx, agent, 10);
}

async function deleteStalePosts(ctx: AppContext) {
  // Delete all posts in the db older than 1 day with a score less than 0.1
  log.red('Deleting stale posts...')
  const currentTime = Date.now()
  const ONE_DAY = 1000 * 60 * 60 * 24 * 1
  const builder = ctx.db
    .deleteFrom('post')
    .where('first_indexed', '<', currentTime - ONE_DAY)
    .where('score', '<', 0.1)
  await builder.execute()
}

function uriToUrl(uri: string) {
  const split = uri.split('/')
  // https://github.com/bluesky-social/atproto/discussions/2523
  const url = `https://bsky.app/profile/${split[2]}/post/${
    split[split.length - 1]
  }`
  return url
}

async function logPosts(ctx: AppContext, agent: BskyAgent, limit: number) {
  console.log('Logging posts for debugging...')
  const builder = ctx.db
    .selectFrom('post')
    .selectAll()
    .orderBy('score', 'desc')
    .orderBy('first_indexed', 'desc')
    .limit(limit)

  const res = await builder.execute()

  for (const row of res) {
    const post = await agent
      .getPostThread({
        uri: row.uri,
        depth: 1,
      })
      .catch((err) => {
        console.error(err)
        return null
      })
    const data = <any>post?.data.thread.post
    const author = data?.author.displayName
    const text = data?.record.text
    const likes = data?.likeCount
    console.log('--------------------------------------------------------')
    log.green('Author: ' + author)
    log.yellow('Text: ' + text)
    log.red('Likes: ' + likes)
    log.magenta('Score: ' + row.score)
    log.cyan(uriToUrl(row.uri))
  }
}

async function llmEval(ctx: AppContext, agent: BskyAgent) {
  // Select the top 10 posts by score
  const builder = ctx.db
    .selectFrom('post')
    .selectAll()
    .where('needs_eval', '=', 'true')
    .orderBy('score', 'desc')
    .limit(20)

  const res = await builder.execute()

  const postsToEval: [string, string][] = [] // [uri, text]
  const urisToDelete: string[] = []
  const evaluatedUris: string[] = []

  // Fetch post texts for evaluation
  await Promise.all(
    res.map(async (postRecord) => {
      try {
        const data = await agent.getPostThread({
          uri: postRecord.uri,
          depth: 1,
        })
        const post = data?.data.thread.post as any
        if (post?.record.text) {
          postsToEval.push([postRecord.uri, post.record.text as string])
        }
      } catch (err) {
        console.error(
          `Error fetching post thread for URI ${postRecord.uri}:`,
          err,
        )
      }
    }),
  )

  // Define the expected response format using Zod
  const resFormat = z.object({ isAboutFilm: z.boolean() })

  // Evaluate posts
  for (const [uri, text] of postsToEval) {
    try {
      const completion = await openai.beta.chat.completions.parse({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              'I am a social media feed. I will ask you if a post is about film (like cinema and movies). If the post is about film, you will respond with "true". If it is not about film, you will respond with "false".',
          },
          {
            role: 'user',
            content: `Is this post about film?:

${text}
            `,
          },
        ],
        response_format: zodResponseFormat(resFormat, 'isAboutFilm'),
      })

      const isPostAboutFilm = completion.choices[0].message.parsed?.isAboutFilm

      if (isPostAboutFilm === false) {
        console.log(`llmEval deleting post: ${text}`)
        urisToDelete.push(uri)
      }

      // Track all evaluated URIs
      evaluatedUris.push(uri)
    } catch (error) {
      console.error(`Error evaluating post URI ${uri}:`, error)
    }
  }

  // Delete posts that are not about film
  if (urisToDelete.length > 0) {
    await ctx.db.deleteFrom('post').where('uri', 'in', urisToDelete).execute()
  }

  // Update evaluated posts to set needs_eval = false
  if (evaluatedUris.length > 0) {
    await ctx.db
      .updateTable('post')
      .set({ needs_eval: 'false' })
      .where('uri', 'in', evaluatedUris)
      .execute()
  }
}

export const handler = async (
  ctx: AppContext,
  params: QueryParams,
  agent: BskyAgent,
) => {
  if (!intervalsScheduled) {
    log.yellow('Scheduling intervals...')
    // Schedule a refresh of scores every 15 minutes
    setInterval(() => {
      refreshScores(ctx, agent)
    }, 1000 * 60 * 15)

    // Schedule an llm evaluation every 5 minutes
    setInterval(() => {
      llmEval(ctx, agent)
    }, 1000 * 60 * 5)

    // Schedule a cleanup of stale posts every 2 hours
    setInterval(() => {
      deleteStalePosts(ctx)
    }, 1000 * 60 * 60 * 2)

    // Run the refresh once at the start
    refreshScores(ctx, agent)

    // Run the eval once at the start
    llmEval(ctx, agent)

    // Run the cleanup once at the start
    deleteStalePosts(ctx)

    intervalsScheduled = true
  }

  // Trigger a refresh asynchronously
  refreshScores(ctx, agent)

  let builder = ctx.db
    .selectFrom('post')
    .selectAll()
    .where('score', '>', 0)
    .orderBy('score', 'desc')
    .orderBy('first_indexed', 'desc')
    .limit(params.limit)

  if (params.cursor) {
    builder = builder.where(
      'post.first_indexed',
      '<',
      parseInt(params.cursor, 10),
    )
  }
  const res = await builder.execute()

  // for (const row of res) {
  //   console.log(row);
  //   console.log(uriToUrl(row.uri));
  // }

  const feed = res.map((row) => ({
    post: row.uri,
  }))

  let cursor: string | undefined
  const last = res.at(-1)
  if (last) {
    cursor = last.first_indexed + ''
  }

  console.log('Responding to request with ' + feed.length + ' posts')

  return {
    cursor,
    feed,
  }
}
