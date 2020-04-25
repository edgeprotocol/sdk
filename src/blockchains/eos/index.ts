import { JsonRpc } from 'eosjs';
import fetch from 'node-fetch';
import * as helpers from '../../helpers';
import { Token, Converter, ConversionEvent, BlockchainType } from '../../types';
import legacyConverters from './legacy_converters';

const anchorToken:Token = {
    blockchainType: BlockchainType.EOS,
    blockchainId: 'bntbntbntbnt',
    symbol: 'BNT'
};

export class EOS {
    jsonRpc: JsonRpc;

    static async create(nodeEndpoint: string): Promise<EOS> {
        const eos = new EOS();
        eos.jsonRpc = new JsonRpc(nodeEndpoint, { fetch });
        return eos;
    }

    static async destroy(eos: EOS): Promise<void> {
    }

    async refresh(): Promise<void> {
    }

    getAnchorToken(): Token {
        return anchorToken;
    }

    async getPath(from: Token, to: Token): Promise<Token[]> {
        const anchorToken = this.getAnchorToken();
        const sourcePath = await this.getPathToAnchor(this.jsonRpc, from, anchorToken);
        const targetPath = await this.getPathToAnchor(this.jsonRpc, to, anchorToken);
        return this.getShortestPath(sourcePath, targetPath);
    }

    async getRateByPath(path: Token[], amount): Promise<string> {
        for (let i = 0; i < path.length - 1; i += 2)
            amount = await this.getConversionRate(this.jsonRpc, path[i + 1], path[i], path[i + 2], amount);
        return amount;
    }

    async getConverterVersion(converter: Converter): Promise<string> {
        return '1.0';
    }

    async getConversionEvents(token: Token, fromBlock: number, toBlock: number): Promise<ConversionEvent[]> {
        throw new Error('getConversionEvents not supported on eos');
    }

    async getConversionEventsByTimestamp(token: Token, fromTimestamp: number, toTimestamp: number): Promise<ConversionEvent[]> {
        throw new Error('getConversionEventsByTimestamp not supported on eos');
    }

    private async getConverterSettings(jsonRpc, converter: Converter) {
        let res = await jsonRpc.get_table_rows({
            json: true,
            code: converter.blockchainId,
            scope: converter.blockchainId,
            table: 'settings',
            limit: 1
        });
        return res.rows[0];
    };
    
    private async getSmartTokenStat(jsonRpc, smartToken: Token) {
        let stat = await jsonRpc.get_table_rows({
            json: true,
            code: smartToken.blockchainId,
            scope: smartToken.symbol,
            table: 'stat',
            limit: 1
        });
        return stat.rows[0];
    };
    
    private async getReserves(jsonRpc, converter: Converter) {
        let res = await jsonRpc.get_table_rows({
            json: true,
            code: converter.blockchainId,
            scope: converter.blockchainId,
            table: 'reserves',
            limit: 10
        });
        return res.rows;
    };
    
    private async getReserveBalance(jsonRpc, converter: Converter, reserveToken: Token) {
        let res = await jsonRpc.get_table_rows({
            json: true,
            code: reserveToken.blockchainId,
            scope: converter.blockchainId,
            table: 'accounts',
            limit: 1
        });
        return this.getBalance(res.rows[0].balance);
    };
    
    private getReserve(reserves, reserveToken: Token) {
        return reserves.filter(reserve => {
            return reserve.contract == reserveToken.blockchainId &&
                   this.getSymbol(reserve.currency) == reserveToken.symbol;
        })[0];
    }
    
    private getBalance(asset) {
        return asset.split(' ')[0];
    }
    
    private getSymbol(asset) {
        return asset.split(' ')[1];
    }
    
    private getDecimals(amount) {
        return amount.split('.')[1].length;
    }
    
    private async getConversionRate(jsonRpc: JsonRpc, smartToken: Token, sourceToken: Token, targetToken: Token, amount: string) {
        let smartTokenStat = await this.getSmartTokenStat(jsonRpc, smartToken);
        let converterBlockchainId = await smartTokenStat.issuer;
        let converter: Converter = {
            blockchainType: BlockchainType.EOS,
            blockchainId: converterBlockchainId,
            symbol: smartToken.symbol
        };
    
        let conversionSettings = await this.getConverterSettings(jsonRpc, converter);
        let conversionFee = conversionSettings.fee;
        let reserves = await this.getReserves(jsonRpc, converter);
        let magnitude = 1;
        let targetDecimals = 4;
        let returnAmount;
    
        // sale
        if (helpers.isTokenEqual(sourceToken, smartToken)) {
            let supply = this.getBalance(smartTokenStat.supply);
            let reserveBalance = await this.getReserveBalance(jsonRpc, converter, targetToken);
            let reserveRatio = this.getReserve(reserves, targetToken).ratio;
            targetDecimals = this.getDecimals(reserveBalance);
            returnAmount = helpers.calculateSaleReturn(supply, reserveBalance, reserveRatio, amount);
        }
        // purchase
        else if (helpers.isTokenEqual(targetToken, smartToken)) {
            let supply = this.getBalance(smartTokenStat.supply);
            let reserveBalance = await this.getReserveBalance(jsonRpc, converter, sourceToken);
            let reserveRatio = this.getReserve(reserves, sourceToken).ratio;
            targetDecimals = this.getDecimals(supply);
            returnAmount = helpers.calculatePurchaseReturn(supply, reserveBalance, reserveRatio, amount);
        }
        else {
            // cross convert
            let sourceReserveBalance = await this.getReserveBalance(jsonRpc, converter, sourceToken);
            let sourceReserveRatio = this.getReserve(reserves, sourceToken).ratio;
            let targetReserveBalance = await this.getReserveBalance(jsonRpc, converter, targetToken);
            let targetReserveRatio = this.getReserve(reserves, targetToken).ratio;
            targetDecimals = this.getDecimals(targetReserveBalance);
            returnAmount = helpers.calculateCrossReserveReturn(sourceReserveBalance, sourceReserveRatio, targetReserveBalance, targetReserveRatio, amount);
            magnitude = 2;
        }
    
        returnAmount = helpers.getFinalAmount(returnAmount, conversionFee, magnitude);
        return helpers.toDecimalPlaces(returnAmount, targetDecimals);
    }
    
    private async getTokenSmartTokens(token: Token) {
        let smartTokens: Token[] = [];
    
        // search in legacy converters
        for (let converterAccount in legacyConverters) {
            let converter = legacyConverters[converterAccount];
    
            // check if the token is the converter smart token
            if (converter.smartToken[token.blockchainId] == token.symbol)
                smartTokens.push(token);
    
            // check if the token is one of the converter's reserve tokens
            for (let reserveAccount in converter.reserves) {
                if (reserveAccount == token.blockchainId && converter.reserves[reserveAccount] == token.symbol) {
                    let smartTokenAccount = Object.keys(converter.smartToken)[0];
                    smartTokens.push({
                        blockchainType: BlockchainType.EOS,
                        blockchainId: smartTokenAccount,
                        symbol: converter.smartToken[smartTokenAccount]
                    });
                }
            }
        }
    
        return smartTokens;
    }
    
    private async getPathToAnchor(jsonRpc: JsonRpc, token: Token, anchorToken: Token) {
        if (helpers.isTokenEqual(token, anchorToken))
            return [token];
    
        // hardcoded path for legacy converters
        const smartTokens = await this.getTokenSmartTokens(token);
        if (smartTokens.length == 0)
            return [];
    
        return [token, smartTokens[0], anchorToken];
    }
    
    private getShortestPath(sourcePath, targetPath) {
        if (sourcePath.length > 0 && targetPath.length > 0) {
            let i = sourcePath.length - 1;
            let j = targetPath.length - 1;
            while (i >= 0 && j >= 0 && helpers.isTokenEqual(sourcePath[i], targetPath[j])) {
                i--;
                j--;
            }
    
            const path = [];
            for (let m = 0; m <= i + 1; m++)
                path.push(sourcePath[m]);
            for (let n = j; n >= 0; n--)
                path.push(targetPath[n]);
    
            let length = 0;
            for (let p = 0; p < path.length; p += 1) {
                for (let q = p + 2; q < path.length - p % 2; q += 2) {
                    if (helpers.isTokenEqual(path[p], path[q]))
                        p = q;
                }
                path[length++] = path[p];
            }
    
            return path.slice(0, length);
        }
    
        return [];
    }
    
}
