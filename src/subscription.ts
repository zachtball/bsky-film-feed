import {
  OutputSchema as RepoEvent,
  isCommit,
} from './lexicon/types/com/atproto/sync/subscribeRepos'
import { FirehoseSubscriptionBase, getOpsByType } from './util/subscription'
import { settings } from './settings'

const POST_METRIC = 'bluesky.feed.eligiblePosts'
const TOTAL_POSTS_METRIC = 'bluesky.feed.totalPosts'

function hasMatch(
  text: string,
  keywords: string[],
  partialKeywords: string[],
  negativeKeywords: string[],
) {
  return getMatch(text, keywords, partialKeywords, negativeKeywords) !== null
}

function getMatch(
  text: string,
  keywords: string[],
  partialKeywords: string[],
  negativeKeywords: string[],
) {
  const multipleSpaces = / {2,}/g
  const lowerText = text.toLowerCase()
  const textWithSpaces =
    (' ' + lowerText + ' ')
      .replaceAll('\n', ' ')
      .replaceAll(', ', ' ')
      .replaceAll('. ', ' ')
      .replaceAll('! ', ' ')
      .replaceAll('? ', ' ')
      .replaceAll(multipleSpaces, ' ') + ' '
  // return (keywords.some(keyword => textWithSpaces.includes(" " + keyword + " "))
  //   || partialKeywords.some(keyword => lowerText.includes(keyword)))
  //   && !negativeKeywords.some(keyword => lowerText.includes(keyword));
  for (const keyword of negativeKeywords) {
    if (lowerText.includes(keyword)) {
      return null
    }
  }
  for (const keyword of keywords) {
    if (textWithSpaces.includes(' ' + keyword + ' ')) {
      return keyword
    }
  }
  for (const keyword of partialKeywords) {
    if (lowerText.includes(keyword)) {
      return keyword
    }
  }
  return null
}

function calculateMod(
  text: string,
  boostedKeywords: { [key: string]: number },
) {
  let boost: number | null = null
  for (const keyword in boostedKeywords) {
    if (text.includes(keyword)) {
      // Don't allow boosts to stack
      boost = Math.max(
        boost ?? Number.MIN_SAFE_INTEGER,
        boostedKeywords[keyword],
      )
    }
  }
  return boost ?? 0
}

export { hasMatch }

export class FirehoseSubscription extends FirehoseSubscriptionBase {
  matchedCount = 0
  totalPostsCounter = 0
  keywords: string[] = []
  partialKeywords: string[] = []
  negativeKeywords: string[] = []
  boostedKeywords: { [key: string]: number } = {}
  settingsLastUpdated = 0
  totalCountMetricLastUpdated = 0

  async updateSettings() {
    this.settingsLastUpdated = Date.now()
    this.keywords = settings.keywords.map((keyword: string) =>
      keyword.toLowerCase(),
    )
    this.partialKeywords = settings.partialKeywords.map((keyword: string) =>
      keyword.toLowerCase(),
    )
    this.negativeKeywords = settings.negativeKeywords.map((keyword: string) =>
      keyword.toLowerCase(),
    )
    this.boostedKeywords = settings.boostedKeywords
    // Add boosted keywords to partial keywords
    this.partialKeywords.push(...Object.keys(this.boostedKeywords))
  }

  async handleEvent(evt: RepoEvent) {
    if (Date.now() - this.settingsLastUpdated > 10000) {
      await this.updateSettings()
    }
    if (Date.now() - this.totalCountMetricLastUpdated > 60000) {
      this.totalCountMetricLastUpdated = Date.now()
      this.totalPostsCounter = 0
    }

    if (!isCommit(evt)) return
    const ops = await getOpsByType(evt)

    const postsToDelete = ops.posts.deletes.map((del) => del.uri)
    const postsToCreate = ops.posts.creates
      .filter((create) => {
        this.totalPostsCounter++
        let match =
          !create.record.reply &&
          (!create.record.langs || create.record.langs?.includes('en'))
        const numberOfHashtags = (create.record.text.match(/#/g) || []).length
        match = match && numberOfHashtags <= 6
        let matchedKeyword: String | null = null
        if (match) {
          // match = hasMatch(create.record.text, this.keywords, this.partialKeywords, this.negativeKeywords);
          matchedKeyword = getMatch(
            create.record.text,
            this.keywords,
            this.partialKeywords,
            this.negativeKeywords,
          )
          match = matchedKeyword !== null
        }
        if (match) {
          this.matchedCount++
          const split = create.uri.split('/')
          // https://github.com/bluesky-social/atproto/discussions/2523
          const url = `https://bsky.app/profile/${split[2]}/post/${
            split[split.length - 1]
          }`
          // console.log("--------------------------------------------------------");
          console.log(url)
          console.log(create.record.text)
          console.log(this.matchedCount)
        }
        return match
      })
      .map((create) => {
        const mod = calculateMod(create.record.text, this.boostedKeywords)
        // Map matched posts to a db row
        // console.dir(create);
        const now = Date.now()
        return {
          uri: create.uri,
          cid: create.cid,
          first_indexed: now,
          score: 0,
          last_scored: 0,
          mod: mod,
        }
      })

    if (postsToDelete.length > 0) {
      await this.db
        .deleteFrom('post')
        .where('uri', 'in', postsToDelete)
        .execute()
    }
    if (postsToCreate.length > 0) {
      await this.db
        .insertInto('post')
        .values(postsToCreate)
        .onConflict((oc) => oc.doNothing())
        .execute()
    }
  }
}
