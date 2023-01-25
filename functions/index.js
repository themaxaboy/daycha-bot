const functions = require("firebase-functions");
const ccxt = require("ccxt");
const exchange = new ccxt.binance();

// Create and Deploy Your First Schedule Functions
// https://firebase.google.com/docs/functions/schedule-functions
exports.ema1hScreener = functions
  .runWith({ memory: "256MB", timeoutSeconds: 180 })
  .pubsub.schedule("4 */2 * * *")
  .timeZone("Asia/Bangkok")
  .onRun(async (context) => {
    await startScan("1h");
    return null;
  });

exports.ema4hScreener = functions
  .runWith({ memory: "256MB", timeoutSeconds: 180 })
  .pubsub.schedule("2 */4 * * *")
  .timeZone("Asia/Bangkok")
  .onRun(async (context) => {
    await startScan("4h");
    return null;
  });

exports.ema1dScreener = functions
  .runWith({ memory: "256MB", timeoutSeconds: 180 })
  .pubsub.schedule("0 */7 * * *")
  .timeZone("Asia/Bangkok")
  .onRun(async (context) => {
    await startScan("1d");
    return null;
  });

// Create and Deploy Your First Cloud Functions
// https://firebase.google.com/docs/functions/write-firebase-functions
exports.forcescan = functions
  .runWith({ memory: "256MB", timeoutSeconds: 180 })
  .https.onRequest(async (request, response) => {
    let timeframe = request.query.timeframe;
    if (["1h", "4h", "1d"].includes(timeframe)) {
      const result = await startScan(timeframe);
      response.status(200).send(result);
    } else {
      response.status(400).send("Timeframe is require (1h, 4h, 1d).");
    }
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const calculateEMA = (values, period) => {
  const EMA = require("technicalindicators").EMA;
  const ema = EMA.calculate({ period: period, values: values });
  return ema;
};

const checkCross = (lineA, lineB) => {
  if (lineA.length !== 2 && lineA.length !== 2) {
    return false;
  }

  if (lineA[0] <= lineB[0] && lineA[1] > lineB[1]) {
    return "UP";
  } else if (lineA[0] > lineB[0] && lineA[1] < lineB[1]) {
    return "DOWN";
  }

  return false;
};

const blacklist = [
  "USDC",
  "USDP",
  "USDSB",
  "BUSD",
  "SUSD",
  "TUSD",
  "USDSB",
  "VEN",
  "UST",
  "DAI",
  "FRAX",
  "USDN",
  "LUSD",
  "USDD",
];

const startScan = async (timeframe) => {
  let result = [];
  const FETCH_LIMIT = 100;

  functions.logger.info("Start scaning...");
  await exchange.load_markets();

  if (exchange.has["fetchOHLCV"]) {
    const marketsFiltered = [];
    Object.entries(exchange.markets).forEach((market) => {
      const { active, base, quote, symbol } = market[1];
      if (!active) {
        return;
      }

      if (quote !== "USDT") {
        return;
      }

      if (symbol.endsWith("BULL/USDT") || symbol.endsWith("BEAR/USDT")) {
        return;
      }

      if (symbol.endsWith("UP/USDT") || symbol.endsWith("DOWN/USDT")) {
        return;
      }

      if (blacklist.includes(base)) {
        return;
      }

      marketsFiltered.push(symbol);
    });

    for (const symbol of marketsFiltered.slice(0, FETCH_LIMIT)) {
      await sleep(exchange.rateLimit);
      try {
        const tickers = await exchange.fetchOHLCV(
          symbol,
          timeframe,
          undefined,
          100
        );
        if (tickers.length) {
          const priceList = tickers.map((c) => c[4]);
          const emaFast = calculateEMA(priceList, 13);
          const emaSlow = calculateEMA(priceList, 34);

          const emaCross = checkCross(emaFast.slice(-2), emaSlow.slice(-2));

          if (emaCross) {
            result.push({
              symbol: symbol,
              emaCross: emaCross,
            });
          }
        }
      } catch (error) {
        functions.logger.error(error);
      }
    }
  }

  functions.logger.info("End scaning...");
  sendLineNotify(result, timeframe);
  return result;
};

const sendLineNotify = async (result, timeframe) => {
  if (!result.length) {
    return;
  }
  functions.logger.info("Start sending notify...");

  const notifySDK = require("line-notify-sdk");
  const notify = new notifySDK();
  const token = "replace-with-your-token";

  const massage = `📣 สัญญาณมาครับ 🔔\n${timeframeFormatter(timeframe)}

${await makeSymbolInfo(result)}
${await makeQuote()}`;

  await notify
    .notify(token, massage)
    .then((body) => {
      functions.logger.info("Send notify success.", body);
    })
    .catch((error) => functions.logger.error(error));

  functions.logger.info("End sending notify...");
};

const makeSymbolInfo = async (result) => {
  const emaCrossUp = result
    .filter((r) => r.emaCross === "UP")
    .map((r) => r.symbol);
  const emaCrossDown = result
    .filter((r) => r.emaCross === "DOWN")
    .map((r) => r.symbol);

  if (exchange.has["fetchTicker"]) {
    const tickers = await exchange.fetchTickers([
      ...emaCrossUp,
      ...emaCrossDown,
    ]);

    let info = "";

    if (emaCrossUp.length) {
      emaCrossUp.forEach((symbol) => {
        info += `🟢 ${symbol.replace("/USDT", "")} - $${
          tickers[symbol].last
        } (${tickers[symbol].percentage.toFixed(2)}%)\n`;
      });
      info += "\n";
    }

    if (emaCrossDown.length) {
      emaCrossDown.forEach((symbol) => {
        info += `🔴 ${symbol.replace("/USDT", "")} - $${
          tickers[symbol].last
        } (${tickers[symbol].percentage.toFixed(2)}%)\n`;
      });
    }

    return info;
  }
};

const makeQuote = () => {
  return new Promise((resolve, reject) => {
    const https = require("https");
    https
      .get("https://zenquotes.io/api/random", (resp) => {
        let data = "";

        resp.on("data", (chunk) => {
          data += chunk;
        });

        resp.on("end", () => {
          let quote = JSON.parse(data)[0];
          resolve(`🍀 ${quote.q}\n📝 ${quote.a}.`);
        });
      })
      .on("error", (err) => {
        reject("");
      });
  });
};

const timeframeFormatter = (timeframe) => {
  switch (timeframe) {
    case "1h":
      return "🤔 กรอบเวลาราย 1 ชั่วโมง\n🤔 พิจารณา ติดตามราคา";
    case "4h":
      return "⭐️⭐️ กรอบเวลาราย 4 ชั่วโมง\n⭐️⭐️ พิจารณา ซื้อเพิ่ม/ลดความเสี่ยง";
    case "1d":
      return "🚨🚨🚨 กรอบเวลาราย 1 วัน\n🚨🚨🚨 พิจารณา ซื้อ/ขาย";
    default:
      return timeframe;
  }
};
