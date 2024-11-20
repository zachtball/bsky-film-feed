import { AppContext } from '../config'
import {
  QueryParams,
  OutputSchema as AlgoOutput,
} from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import * as hot from './hot'
import { BskyAgent } from '@atproto/api'

type AlgoHandler = (
  ctx: AppContext,
  params: QueryParams,
  agent: BskyAgent,
) => Promise<AlgoOutput>

const algos: Record<string, AlgoHandler> = {
  [hot.shortname]: hot.handler,
}

export default algos
