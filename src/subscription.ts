import { AtpAgent } from '@atproto/api'
import {
  OutputSchema as RepoEvent,
  isCommit,
} from './lexicon/types/com/atproto/sync/subscribeRepos'
import { FirehoseSubscriptionBase, getOpsByType } from './util/subscription'
const agent = new AtpAgent({ service: 'https://public.api.bsky.app' })
const filmKeywords = [
  'film',
  'movie',
  'cinema',
  'hollywood',
  'bollywood',
  'screenplay',
  'director',
  'actress',
  'actor',
  'oscars',
  'screenwriter',
  'blockbuster',
  'indie film',
  'filmsky',
  'theater',
  'theaters',
]

export class FirehoseSubscription extends FirehoseSubscriptionBase {
  async handleEvent(evt: RepoEvent) {
    if (!isCommit(evt)) return

    const ops = await getOpsByType(evt)

    const postsToDelete = ops.posts.deletes.map((del) => del.uri)
    const postsToCreate = ops.posts.creates.filter((create) => {
      // only film posts
      const isAboutFilm = this.isPostAboutFilm(create.record.text)
      return isAboutFilm
    })
    const resolvedPosts = await Promise.all(
      postsToCreate.map(async (create) => {
        let likes = 0
        try {
          const likesRes = await agent.api.app.bsky.feed.getLikes({
            uri: create.uri,
          })
          likes = likesRes.data.likes.length
        } catch (e) {
          console.error('failed to get likes', e)
        }

        const indexedAt = new Date().toISOString()

        // const hotScore = this.calculateHotScore(likes, reposts, new Date().toISOString());
        // map film posts to a db row
        return {
          uri: create.uri,
          cid: create.cid,
          indexedAt,
          hotScore: this.calculateHotScore(likes, indexedAt),
        }
      }),
    )

    if (postsToDelete.length > 0) {
      await this.db
        .deleteFrom('post')
        .where('uri', 'in', postsToDelete)
        .execute()
    }
    if (resolvedPosts.length > 0) {
      await this.db
        .insertInto('post')
        .values(resolvedPosts)
        .onConflict((oc) => oc.doNothing())
        .execute()
    }
  }

  /**
   * Determines if a post is about films using keywords.
   */
  isPostAboutFilm(postText: string) {
    const lowerText = postText.toLowerCase()
    const containsKeywords = filmKeywords.some((keyword) =>
      lowerText.includes(keyword),
    )
    return containsKeywords
  }

  calculateHotScore(likes: number, indexedAt: string): number {
    const hoursSincePosted =
      (Date.now() - new Date(indexedAt).getTime()) / (1000 * 60 * 60)

    // Apply exponential decay for penalizing older posts
    const timePenalty = Math.pow(hoursSincePosted, 1.5) * 0.1

    return likes * 2 - timePenalty
  }
}
