import { BigNumber, RfqtFirmQuoteValidator, SignedOrder } from '@0x/asset-swapper';
import { assetDataUtils, ERC20AssetData } from '@0x/order-utils';
import { In, IsNull, Not } from 'typeorm';
import { Repository } from 'typeorm/repository/Repository';
import { ONE_SECOND_MS } from '../constants';
import { MakerBalanceChainCache } from '../entities/MakerBalanceChainCacheEntity';
import { logger } from '../logger';


const BIG_NUMBER_ZERO = new BigNumber(0);
const THRESHOLD_CACHE_EXPIRED_MS = 2 * 60 * ONE_SECOND_MS;


export class PostgresBackedFirmQuoteValidator implements RfqtFirmQuoteValidator {
    private readonly _chainCacheRepository: Repository<MakerBalanceChainCache>;

    constructor(chainCacheRepository: Repository<MakerBalanceChainCache>) {
        this._chainCacheRepository = chainCacheRepository;
    }

    // tslint:disable-next-line: prefer-function-over-method
    async getRFQTTakerFillableAmounts(quotes: SignedOrder[]): Promise<BigNumber[]> {

        if (quotes.length === 0) {
            return [];
        }

        // Ensure that all quotes have the same exact maker token.
        const makerTokenAddressesSet = new Set(
            quotes.map(quote => {
                const decodedAssetData = assetDataUtils.decodeAssetDataOrThrow(quote.makerAssetData) as ERC20AssetData;
                return decodedAssetData.tokenAddress;
            })
        );
        const makerTokenAddresses = Array.from(makerTokenAddressesSet);
        if (makerTokenAddresses.length !== 1) {
            logger.error(`Found multiple maker token addresses within one single RFQ batch: ${JSON.stringify(makerTokenAddresses)}. Rejecting the batch`);
            return quotes.map(_quote => BIG_NUMBER_ZERO);
        }

        // Collect a list of maker addresses
        const makerAddressesSet = new Set(quotes.map(quote => quote.makerAddress));
        const makerAddresses = Array.from(makerAddressesSet);

        // Fetch balances and create a lookup table
        const makerLookup: {[key: string]: BigNumber} = {};
        // TODO: Handle error on query
        const cacheResults = await this._chainCacheRepository.find({
            where: [{
                tokenAddress: makerTokenAddresses[0],
                makerAddress: In(makerAddresses),
            }],
        });
        const nowUnix = (new Date()).getTime();
        for (const result of cacheResults) {

            if (!result.timeOfSample) {
                // If a record exists but a time of sample does not yet exist, this means that the cache entry has not yet been
                // populated by the worker process. This may be due to a new address being added a few minutes ago, but it could
                // also be due to a bug in the worker.
                const timeFirstSeen = result.timeFirstSeen ? result.timeFirstSeen.getTime() : 0;
                const msPassedSinceLastSeen = nowUnix - timeFirstSeen;
                if (msPassedSinceLastSeen > THRESHOLD_CACHE_EXPIRED_MS) {
                    logger.error(`Cache entry for maker ${result.makerAddress} and token ${result.tokenAddress} was first added on ${timeFirstSeen} which is more than ${THRESHOLD_CACHE_EXPIRED_MS}. Assuming worker is stuck.`)
                    makerLookup[result.makerAddress!] = BIG_NUMBER_ZERO;
                } else {
                    logger.error(`Cannot find cache for token ${makerTokenAddresses[0]} and maker ${result.makerAddress}. This entry was recently added so assuming the entire taker fillable amount is available`);
                    makerLookup[result.makerAddress!] = new BigNumber(Number.POSITIVE_INFINITY);
                }
            } else if (nowUnix - result.timeOfSample.getTime() > THRESHOLD_CACHE_EXPIRED_MS) {
                // In this case a cache entry exists, but it's simply too old and this should never really happen unless the worker is stuck.
                logger.error(`Cache entry for maker ${result.makerAddress} and token ${result.tokenAddress} was last refreshed on ${result.timeOfSample.getTime()} which is more than ${THRESHOLD_CACHE_EXPIRED_MS}. Assuming worker is stuck.`)
                makerLookup[result.makerAddress!] = BIG_NUMBER_ZERO;
            } else {
                // Quick validity check to ensure data isn't invalid. This should never happen if `timeOfSample` exists.
                if (!result.balance) {
                    logger.error(`Cache entry for maker ${result.makerAddress} and token ${result.tokenAddress} has a null balance. This should never happen`);
                    makerLookup[result.makerAddress!] = BIG_NUMBER_ZERO;
                }
                makerLookup[result.makerAddress!] = result.balance;
            }
        }

        // Finally, adjust takerFillableAmount based on maker balances
        const makerAddressesToAddToCacheSet: Set<string> = new Set();
        const takerFillableAmounts =  quotes.map(quote => {
            const makerTokenBalanceForMaker: BigNumber | undefined = makerLookup[quote.makerAddress];

            // TODO: Add Prometheus hooks
            if (makerTokenBalanceForMaker === undefined) {
                makerAddressesToAddToCacheSet.add(quote.makerAddress);
                return quote.takerAssetAmount;
            }

            // Order is fully fillable, because Maker has 100% of the assets
            if (makerTokenBalanceForMaker.gte(quote.makerAssetAmount)) {
                return quote.takerAssetAmount;
            }

            // Order is empty, return zero
            if (quote.makerAssetAmount.lte(0)) {
                return BIG_NUMBER_ZERO;
            }

            // Order is partially fillable, because Maker has a fraction of the assets
            const partialFillableAmount = makerTokenBalanceForMaker.times(quote.takerAssetAmount).div(quote.makerAssetAmount).integerValue(BigNumber.ROUND_DOWN);
            if (!partialFillableAmount.isFinite()) {
                logger.error(`Calculated maker token balance is infinite, which caused the partialFillableAmount to be infinite. This should never happen`);
                return BIG_NUMBER_ZERO;
            }
            return partialFillableAmount;
        });

        // If any new addresses were found, add new addresses to cache.
        // NOTE: since this insertion happens on the web processes, we need to gracefully handle conflict
        // that can happen if two threads try to insert the same entry at the same time. This is why we add
        // the "ON CONFLICT" clause.
        const makerAddressesToAddToCache = Array.from(makerAddressesToAddToCacheSet);
        if (makerAddressesToAddToCache.length > 0) {
            logger.info(`Adding new addresses to cache: ${JSON.stringify(makerAddressesToAddToCache)}`);
            await this._chainCacheRepository
                .createQueryBuilder()
                .insert()
                .values(
                    makerAddressesToAddToCache.map(makerAddress => {
                        return {
                            makerAddress,
                            tokenAddress: makerTokenAddresses[0],
                            timeFirstSeen: 'NOW()',
                        };
                    })
                )
                .onConflict(`("token_address", "maker_address") DO NOTHING`)
                .execute();
        }
        return takerFillableAmounts;
    }

}
