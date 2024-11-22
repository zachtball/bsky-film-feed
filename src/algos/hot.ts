import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import { AppContext } from '../config'
import { BskyAgent } from '@atproto/api'
import { log } from 'console-log-colors'
import { llmEval } from './helpers/llmEval'
import { deleteStalePosts } from './helpers/deleteStalePosts'
import { refreshScores } from './helpers/refreshScores'

// max 15 chars
export const shortname = 'hot'

let intervalsScheduled = false

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

    // Schedule an llm evaluation every 1 minute
    setInterval(() => {
      llmEval(ctx, agent)
    }, 1000 * 60 * 1)

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
