require('dotenv').config();

const { ZENROWS_API_KEY } = process.env;
const puppeteer = require('puppeteer-core');
const connectionURL = `wss://browser.zenrows.com?apikey=${ZENROWS_API_KEY}`;

(async () => {
    const browser = await puppeteer.connect({ browserWSEndpoint: connectionURL });
    const page = await browser.newPage();
    await page.goto('https://jumia.com.ng');
    console.log(await page.title());
    await browser.close();
})();