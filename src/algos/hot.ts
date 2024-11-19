import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import { AppContext } from '../config'

// max 15 chars
export const shortname = 'hot'

export const handler = async (ctx: AppContext, params: QueryParams) => {
  let builder = ctx.db
    .selectFrom('post')
    .selectAll()
    .orderBy('hotScore', 'desc') // Order by hotScore for "hot" posts
    .orderBy('indexedAt', 'desc') // Secondary ordering by recency
    .limit(params.limit)

  if (params.cursor) {
    // Split the cursor into hotScore and indexedAt parts
    const [hotScoreStr, timeStr] = params.cursor.split('::')
    const hotScore = parseFloat(hotScoreStr)
    const indexedAt = new Date(parseInt(timeStr, 10)).toISOString()

    // Pagination logic: Fetch posts with lower hotScore or older indexedAt
    builder = builder
      .where((eb) =>
        eb.or([
          eb('post.hotScore', '<', hotScore),
          eb('post.hotScore', '=', hotScore),
        ]),
      )
      .where('post.indexedAt', '<', indexedAt)
  }
  const res = await builder.execute()

  const feed = res.map((row) => ({
    post: row.uri,
  }))

  let cursor: string | undefined
  const last = res.at(-1)
  if (last) {
    cursor = `${last.hotScore}::${new Date(last.indexedAt).getTime()}`
  }

  return {
    cursor,
    feed,
  }
}
