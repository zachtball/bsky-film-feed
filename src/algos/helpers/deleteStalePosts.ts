import { AppContext } from '../../config'
import { log } from 'console-log-colors'

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

export { deleteStalePosts }
