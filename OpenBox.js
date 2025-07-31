const fs = require('fs');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const readline = require('readline-sync');
const colors = require('colors');
const bs58 = require('bs58');
const nacl = require('tweetnacl');
const { Keypair } = require('@solana/web3.js');
const { v4: uuidv4 } = require('uuid');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const proxies = fs.readFileSync('proxy.txt', 'utf-8').split('\n').filter(Boolean);
const userAgents = fs.readFileSync('ua.txt', 'utf-8').split('\n').filter(Boolean);

const walletFile = 'wallet_sol.json';
const openFile = 'open.json';
let openData = {};

if (fs.existsSync(openFile)) {
  try {
    openData = JSON.parse(fs.readFileSync(openFile, 'utf-8'));
  } catch (err) {
    openData = {};
    console.log(`${colors.yellow('[!] Error reading open.json, creating new.')}`);
  }
}

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

function signMessage(message, privateKey) {
  try {
    const messageBytes = new TextEncoder().encode(message);
    const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
    const signature = nacl.sign.detached(messageBytes, keypair.secretKey);
    return Buffer.from(signature).toString('base64');
  } catch (error) {
    throw new Error(`Signing failed: ${error.message}`);
  }
}

function getNFTInfo(templateId) {
  const rarityMap = {
    'labubu-00000-1': { name: 'Blooming Spirit', rarity: 'NFT 10x', color: colors.green },
    'labubu-00000-2': { name: 'Wise Spirit', rarity: 'NFT 10x', color: colors.green },
    'labubu-00000-3': { name: 'Guardian Spirit', rarity: 'NFT 10x', color: colors.green },
    'labubu-00000-4': { name: 'Midnight Spirit', rarity: 'NFT 100x', color: colors.yellow },
    'labubu-00000-5': { name: 'Starlight Angel', rarity: 'NFT 1000x', color: colors.magenta }
  };
  
  return rarityMap[templateId] || { name: 'Unknown', rarity: 'Unknown', color: colors.gray };
}

function parseProxy(proxyString) {
  const cleanProxy = proxyString.trim();
  
  const match = cleanProxy.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
  if (match) {
    return {
      host: match[3],
      port: parseInt(match[4]),
      username: match[1],
      password: match[2]
    };
  }
  
  const parts = cleanProxy.split(':');
  if (parts.length === 4) {
    return {
      host: parts[0],
      port: parseInt(parts[1]),
      username: parts[2],
      password: parts[3]
    };
  }
  
  throw new Error(`Invalid proxy format: ${cleanProxy}`);
}

async function getBrowserSessionWithPuppeteer(proxyConfig, userAgent) {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                `--proxy-server=${proxyConfig.host}:${proxyConfig.port}`
            ]
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 1024, height: 768 });

        if (proxyConfig.username && proxyConfig.password) {
            await page.authenticate({
                username: proxyConfig.username,
                password: proxyConfig.password
            });
        }

        await page.setUserAgent(userAgent);

        const targetUrl = `https://bubuverse.fun/space`;
        await page.goto(targetUrl, {
            waitUntil: 'networkidle2',
            timeout: 60000
        });

        await new Promise(r => setTimeout(r, 15000)); 

        const pageTitle = await page.title();
        const currentUrl = page.url();
        
        if (!currentUrl.includes('bubuverse.fun')) {
            throw new Error(`Redirect: ${currentUrl}`);
        }
        
        if (pageTitle && (pageTitle.toLowerCase().includes('error') || pageTitle.toLowerCase().includes('blocked'))) {
            throw new Error(`Error page: ${pageTitle}`);
        }

        const cookies = await page.cookies();
        let cookieString = '';
        cookies.forEach(cookie => {
            cookieString += `${cookie.name}=${cookie.value}; `;
        });
        cookieString = cookieString.slice(0, -2);

        const vcrcsCookie = cookies.find(c => c.name === '_vcrcs');

        const deviceId = uuidv4().replace(/-/g, ''); 
        const cookieCreatedAt = new Date().toISOString();
        const cookieExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

        return {
            vcrcsCookie: vcrcsCookie ? vcrcsCookie.value : null,
            allCookies: cookieString,
            cookieCreatedAt: cookieCreatedAt,
            cookieExpiresAt: cookieExpiresAt,
            userAgent: userAgent,
            deviceId: deviceId,
            page: page,
            browser: browser
        };

    } catch (error) {
        if (browser) {
            await browser.close();
        }
        throw error;
    }
}

async function getBoxesWithPuppeteer(page, walletAddress) {
    try {
        const timestamp = Date.now();
        const apiUrl = `https://bubuverse.fun/api/users/${walletAddress}/blind-boxes?status=unopened&_t=${timestamp}`;
        
        const response = await page.evaluate(async (url) => {
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'accept': '*/*',
                    'referer': 'https://bubuverse.fun/space'
                },
                mode: 'cors',
                credentials: 'include'
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            return await response.json();
        }, apiUrl);

        return response.data || [];
    } catch (error) {
        throw new Error(`Failed to get boxes: ${error.message}`);
    }
}

async function openBoxWithPuppeteer(page, walletAddress, privateKey, boxId) {
    try {
        const timestamp = Date.now();
        const message = `Open blind box ${boxId} at ${timestamp}`;
        const signature = signMessage(message, privateKey);

        const body = {
            box_id: boxId,
            signature: signature,
            message: message
        };

        const apiUrl = `https://bubuverse.fun/api/users/${walletAddress}/blind-boxes/open`;
        
        const response = await page.evaluate(async (url, requestBody) => {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'accept': '*/*',
                    'content-type': 'application/json',
                    'referer': 'https://bubuverse.fun/space'
                },
                body: JSON.stringify(requestBody),
                mode: 'cors',
                credentials: 'include'
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            return await response.json();
        }, apiUrl, body);

        return response;
    } catch (error) {
        throw new Error(`Failed to open box: ${error.message}`);
    }
}

function hasNFT(walletAddress) {
  return openData[walletAddress] && openData[walletAddress].length > 0;
}

async function processWallet(wallet, proxyString, walletIndex, totalWallets) {
  const { privateKey, publicKey } = wallet;
  const walletAddress = publicKey;

  console.log(`\n[${walletIndex + 1}/${totalWallets}] ${colors.cyan(walletAddress.substring(0, 8))}...`);

  let proxyConfig = null;
  try {
    proxyConfig = parseProxy(proxyString);
    console.log(`Proxy: ${colors.blue(proxyConfig.host + ':' + proxyConfig.port)}`);
  } catch (error) {
    console.log(`${colors.red('Proxy Error:')} ${error.message}`);
    return false;
  }

  let sessionData = null;
  try {
    console.log(`${colors.yellow('Getting cookies...')}`);
    sessionData = await getBrowserSessionWithPuppeteer(proxyConfig, wallet.userAgent);

    wallet.vcrcsCookie = sessionData.vcrcsCookie;
    wallet.allCookies = sessionData.allCookies;
    wallet.cookieCreatedAt = sessionData.cookieCreatedAt;
    wallet.cookieExpiresAt = sessionData.cookieExpiresAt;
    wallet.deviceId = sessionData.deviceId;

    console.log(`${colors.green('Cookies OK')}`);

  } catch (error) {
    console.log(`${colors.red('Cookies Error:')} ${error.message}`);
    return false;
  }

  try {
    console.log(`${colors.yellow('Checking boxes...')}`);
    const boxes = await getBoxesWithPuppeteer(sessionData.page, walletAddress);

    if (boxes.length === 0) {
      console.log(`${colors.gray('No boxes')}`);
      await sessionData.browser.close();
      return true;
    }

    console.log(`${colors.green('Found')} ${colors.white(boxes.length)} ${colors.green('boxes')}`);

    if (!openData[walletAddress]) {
      openData[walletAddress] = [];
    }

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      const boxId = box.id;

      try {
        console.log(`${colors.yellow('Opening box')} ${colors.white(i + 1)}/${colors.white(boxes.length)}...`);

        const result = await openBoxWithPuppeteer(sessionData.page, walletAddress, privateKey, boxId);
        const templateId = result.template_id;

        openData[walletAddress].push(templateId);

        const nftInfo = getNFTInfo(templateId);
        console.log(nftInfo.color(`  → ${nftInfo.rarity} - ${nftInfo.name}`));

        successCount++;

        if (i < boxes.length - 1) {
          await sleep(2000);
        }

      } catch (error) {
        console.log(`  → ${colors.red('Error:')} ${error.message}`);
        failCount++;

        if (i < boxes.length - 1) {
          await sleep(2000);
        }
      }
    }

    console.log(`${colors.green('Completed:')} ${colors.white(successCount)} ${colors.green('OK')}, ${colors.white(failCount)} ${colors.red('errors')}`);
    fs.writeFileSync(openFile, JSON.stringify(openData, null, 2));
    
    await sessionData.browser.close();
    return true;
  } catch (error) {
    console.log(`${colors.red('Processing Error:')} ${error.message}`);
    if (sessionData && sessionData.browser) {
      await sessionData.browser.close();
    }
    return false;
  }
}

async function processBatchMode() {
  if (!fs.existsSync(walletFile)) {
    console.log(`${colors.red('File')} ${colors.white(walletFile)} ${colors.red('does not exist!')}`);
    return;
  }

  const walletRawData = JSON.parse(fs.readFileSync(walletFile, 'utf-8'));
  const wallets = Array.isArray(walletRawData) ? walletRawData : [];

  if (wallets.length === 0) {
    console.log(`${colors.red('No wallets found in the file!')}`);
    return;
  }

  if (wallets.length > proxies.length) {
    console.log(`${colors.red('Not enough proxies! Need')} ${colors.white(wallets.length)}${colors.red(', have')} ${colors.white(proxies.length)}`);
    return;
  }

  console.log(`${colors.green('Processing')} ${colors.white(wallets.length)} ${colors.green('wallets with')} ${colors.white(proxies.length)} ${colors.green('proxies')}`);

  console.log(`\n${colors.yellow('Preprocessing wallets...')}`);
  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];

    delete wallet.createdAt;
    delete wallet.cookieExpiresAt;
    delete wallet.cookieCreatedAt;
    delete wallet.vcrcsCookie;
    delete wallet.allCookies;

    if (!wallet.deviceId) {
      wallet.deviceId = uuidv4().replace(/-/g, '');
    }
    if (!wallet.userAgent) {
      wallet.userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
    }
  }
  fs.writeFileSync(walletFile, JSON.stringify(wallets, null, 2));
  console.log(`${colors.green('Preprocessing completed')}\n`);

  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    const proxy = proxies[i];

    if (hasNFT(wallet.publicKey)) {
        const nftInfo = getNFTInfo(openData[wallet.publicKey][0]);
        console.log(`\n[${i + 1}/${wallets.length}] ${colors.cyan(wallet.publicKey.substring(0, 8))}...`);
        console.log(`${colors.gray('Skipping - already has')} ${nftInfo.color(nftInfo.rarity)}`);
        await sleep(1000);
        continue;
    }

    const processedSuccessfully = await processWallet(wallet, proxy, i, wallets.length);

    fs.writeFileSync(walletFile, JSON.stringify(wallets, null, 2));

    if (i < wallets.length - 1) {
      console.log(`${colors.gray('Waiting 3s...')}`);
      await sleep(3000);
    }
  }

  showStats();
  console.log(`\n${colors.green('Completed!')}`);
}

function showStats() {
  console.log(`\n${colors.cyan('=== Statistics ===')}`);

  if (Object.keys(openData).length === 0) {
    console.log(`${colors.gray('No data yet')}`);
    return;
  }

  let totalBoxes = 0;
  const rarityCount = {
    '10x': 0,
    '100x': 0,
    '1000x': 0
  };

  for (const [, templates] of Object.entries(openData)) {
    templates.forEach(templateId => {
      totalBoxes++;
      const nftInfo = getNFTInfo(templateId);

      if (nftInfo.rarity.includes('10x')) {
        rarityCount['10x']++;
      } else if (nftInfo.rarity.includes('100x')) {
        rarityCount['100x']++;
      } else if (nftInfo.rarity.includes('1000x')) {
        rarityCount['1000x']++;
      }
    });
  }

  console.log(`\n${colors.cyan('Summary:')}`);
  console.log(`${colors.green('NFT 10x:')} ${colors.white(rarityCount['10x'])}`);
  console.log(`${colors.yellow('NFT 100x:')} ${colors.white(rarityCount['100x'])}`);
  console.log(`${colors.magenta('NFT 1000x:')} ${colors.white(rarityCount['1000x'])}`);
  console.log(`${colors.blue('Total boxes:')} ${colors.white(totalBoxes)}`);
}

console.log(`${colors.cyan('SOLANA BOX OPENER')}`);
console.log(`${colors.green('Loaded')} ${colors.white(proxies.length)} ${colors.green('proxies,')} ${colors.white(userAgents.length)} ${colors.green('user agents')}\n`);

processBatchMode();

process.on('SIGINT', () => {
  console.log(`\n\n${colors.yellow('Saving data...')}`);
  fs.writeFileSync(openFile, JSON.stringify(openData, null, 2));
  console.log(`${colors.green('Saved open.json')}`);
  showStats();
  process.exit(0);
});
