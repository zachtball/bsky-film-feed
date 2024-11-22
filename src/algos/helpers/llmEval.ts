import { BskyAgent } from '@atproto/api'
import { AppContext } from '../../config'
import OpenAI from 'openai'
import { zodResponseFormat } from 'openai/helpers/zod'
import { z } from 'zod'
import dotenv from 'dotenv'
dotenv.config()

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

async function llmEval(ctx: AppContext, agent: BskyAgent) {
  // Select the top 20 posts by score that need eval
  const builder = ctx.db
    .selectFrom('post')
    .selectAll()
    .where('needs_eval', '=', true)
    .orderBy('score', 'desc')
    .limit(10)

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
  const resFormat = z.object({ isAboutCinema: z.boolean() })

  // Evaluate posts
  for (const [uri, text] of postsToEval) {
    console.log(`llmEval evaluating ${text}`)
    try {
      const completion = await openai.beta.chat.completions.parse({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              'I am a social media feed. You will help me moderate the feed and keep discussions on topic. I will ask you if a post is about cinema. If the post is about cinema, you will respond with "true". If it is not about film, you will respond with "false". If a post is about politics respond with "false".',
          },
          {
            role: 'user',
            content: `Is this post about cinema?:

${text}
            `,
          },
        ],
        response_format: zodResponseFormat(resFormat, 'isAboutCinema'),
      })

      const isPostAboutFilm =
        completion.choices[0].message.parsed?.isAboutCinema
      console.log({ isPostAboutFilm })
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
    const urls = urisToDelete.map((uri) => {
      const split = uri.split('/')
      // https://github.com/bluesky-social/atproto/discussions/2523
      const url = `https://bsky.app/profile/${split[2]}/post/${
        split[split.length - 1]
      }`
      return url
    })

    await ctx.db
      .deleteFrom('post')
      .where('uri', 'in', urisToDelete)
      .execute()
      .catch((err) => {
        console.error('Error deleting posts in llmEval:', err)
      })
    console.log('llmEval deleted posts', urls)
  }

  // Update evaluated posts to set needs_eval = false
  if (evaluatedUris.length > 0) {
    await ctx.db
      .updateTable('post')
      .set({ needs_eval: false })
      .where('uri', 'in', evaluatedUris)
      .execute()
      .catch((err) => {
        console.error('Error updating needs_eval:', err)
      })
  }
}

export { llmEval }
