import { BskyAgent } from '@atproto/api'
import { AppContext } from '../../config'

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
    // if (score > 0.2) {
    //   console.log({ likeCount, repostCount, score })
    // }
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
        oc.column('uri').doUpdateSet({
          score: score,
          last_scored: currentTime,
        }),
      )
      .execute()
  }
  // logPosts(ctx, agent, 10);
}

export { refreshScores }
