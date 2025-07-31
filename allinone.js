const fs = require('fs');
const colors = require('colors');
const bs58 = require('bs58');
const nacl = require('tweetnacl');
const { Keypair } = require('@solana/web3.js');
const { v4: uuidv4 } = require('uuid');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const readline = require('readline-sync');

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

async function getBrowserSession(proxyConfig, userAgent, targetUrl) {
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
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(15000);

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

    return { page, browser, cookies: cookieString, vcrcsCookie: cookies.find(c => c.name === '_vcrcs')?.value };
  } catch (error) {
    if (browser) await browser.close();
    throw error;
  }
}

async function checkDailyStatus(page, walletAddress) {
  try {
    const timestamp = Date.now();
    const apiUrl = `https://bubuverse.fun/api/users/${walletAddress}/check-in-status?_t=${timestamp}`;
    const response = await page.evaluate(async (url) => {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'accept': '*/*',
          'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8,vi;q=0.7',
          'cache-control': 'no-cache, no-store, must-revalidate',
          'expires': '0',
          'pragma': 'no-cache',
          'priority': 'u=1, i',
          'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin'
        },
        mode: 'cors',
        credentials: 'include'
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      return await res.json();
    }, apiUrl);
    return response;
  } catch (error) {
    throw new Error(`Failed to check daily status: ${error.message}`);
  }
}

async function performDailyCheckIn(page, walletAddress) {
  try {
    const apiUrl = `https://bubuverse.fun/api/users/${walletAddress}/check-in`;
    const response = await page.evaluate(async (url) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'accept': '*/*',
          'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8,vi;q=0.7',
          'priority': 'u=1, i',
          'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin'
        },
        mode: 'cors',
        credentials: 'include'
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      return await res.json();
    }, apiUrl);
    return response;
  } catch (error) {
    throw new Error(`Failed to perform daily check-in: ${error.message}`);
  }
}

async function checkNFTStats(page, walletAddress) {
  try {
    const apiUrl = `https://bubuverse.fun/api/users/${walletAddress}/nfts/stats`;
    const response = await page.evaluate(async (url) => {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'accept': '*/*',
          'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8,vi;q=0.7',
          'priority': 'u=1, i',
          'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin'
        },
        mode: 'cors',
        credentials: 'include'
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      return await res.json();
    }, apiUrl);
    return response;
  } catch (error) {
    throw new Error(`Failed to check NFT stats: ${error.message}`);
  }
}

async function collectEnergy(page, walletAddress, privateKey) {
  try {
    const timestamp = Date.now();
    const message = `Collect energy at ${timestamp}`;
    const signature = signMessage(message, privateKey);
    const body = { signature, message };
    const apiUrl = `https://bubuverse.fun/api/users/${walletAddress}/nfts/collect-energy`;
    const response = await page.evaluate(async (url, requestBody) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'accept': '*/*',
          'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8,vi;q=0.7',
          'content-type': 'application/json',
          'priority': 'u=1, i',
          'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin'
        },
        body: JSON.stringify(requestBody),
        mode: 'cors',
        credentials: 'include'
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      return await res.json();
    }, apiUrl, body);
    return response;
  } catch (error) {
    throw new Error(`Failed to collect energy: ${error.message}`);
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

async function getBoxes(page, walletAddress) {
  try {
    const timestamp = Date.now();
    const apiUrl = `https://bubuverse.fun/api/users/${walletAddress}/blind-boxes?status=unopened&_t=${timestamp}`;
    const response = await page.evaluate(async (url) => {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'accept': '*/*', 'referer': 'https://bubuverse.fun/space' },
        mode: 'cors',
        credentials: 'include'
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      return await res.json();
    }, apiUrl);
    return response.data || [];
  } catch (error) {
    throw new Error(`Failed to get boxes: ${error.message}`);
  }
}

async function openBox(page, walletAddress, privateKey, boxId) {
  try {
    const timestamp = Date.now();
    const message = `Open blind box ${boxId} at ${timestamp}`;
    const signature = signMessage(message, privateKey);
    const body = { box_id: boxId, signature, message };
    const apiUrl = `https://bubuverse.fun/api/users/${walletAddress}/blind-boxes/open`;
    const response = await page.evaluate(async (url, requestBody) => {
      const res = await fetch(url, {
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
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      return await res.json();
    }, apiUrl, body);
    return response;
  } catch (error) {
    throw new Error(`Failed to open box: ${error.message}`);
  }
}

async function stakeNFTs(page, walletAddress, privateKey) {
  try {
    const timestamp = Date.now();
    const message = `Stake NFTs at ${timestamp}`;
    const signature = signMessage(message, privateKey);
    const body = { signature, message };
    const apiUrl = `https://bubuverse.fun/api/users/${walletAddress}/nfts/stake`;
    const response = await page.evaluate(async (url, requestBody) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'accept': '*/*', 'content-type': 'application/json' },
        body: JSON.stringify(requestBody),
        mode: 'cors',
        credentials: 'include'
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      return await res.json();
    }, apiUrl, body);
    return response;
  } catch (error) {
    throw new Error(`Failed to stake NFTs: ${error.message}`);
  }
}

function isAlreadyCheckedInToday(wallet) {
  if (!wallet.lastCheckinDate) return false;
  const today = new Date().toDateString();
  const lastCheckin = new Date(wallet.lastCheckinDate).toDateString();
  return today === lastCheckin;
}

function markAsCheckedIn(wallet) {
  wallet.lastCheckinDate = new Date().toISOString();
  wallet.hasCollectedToday = true;
}

function hasNFTs(walletAddress) {
  return openData[walletAddress] && openData[walletAddress].length > 0;
}

function isAlreadyStaked(walletAddress) {
  return openData[walletAddress] && openData[walletAddress].some(nft =>
    typeof nft === 'object' && nft.staked === true
  );
}

function markAsStaked(walletAddress, stakeResult) {
  if (!openData[walletAddress]) openData[walletAddress] = [];
  openData[walletAddress] = openData[walletAddress].map(nft => {
    if (typeof nft === 'string') {
      return {
        templateId: nft,
        staked: true,
        stakedAt: new Date().toISOString(),
        stakeResult
      };
    } else if (typeof nft === 'object' && !nft.staked) {
      return { ...nft, staked: true, stakedAt: new Date().toISOString(), stakeResult };
    }
    return nft;
  });
}

async function processDailyCheckIn(wallet, proxyString, walletIndex, totalWallets) {
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
    sessionData = await getBrowserSession(proxyConfig, wallet.userAgent, 'https://bubuverse.fun/tasks');
    console.log(`${colors.green('Cookies OK')}`);
  } catch (error) {
    console.log(`${colors.red('Cookies Error:')} ${error.message}`);
    return false;
  }

  try {
    if (!isAlreadyCheckedInToday(wallet)) {
      console.log(`${colors.yellow('Checking daily check-in...')}`);
      const checkInStatus = await checkDailyStatus(sessionData.page, walletAddress);
      if (checkInStatus.can_check_in) {
        console.log(`${colors.yellow('Performing daily check-in...')}`);
        const checkInResult = await performDailyCheckIn(sessionData.page, walletAddress);
        if (checkInResult.success) {
          console.log(`${colors.green('✓ Check-in Success! Received')} ${colors.white(checkInResult.energy_reward)} ${colors.green('energy (Day')} ${colors.white(checkInResult.check_in_count)}${colors.green(')')}`);
          markAsCheckedIn(wallet);
          console.log(`${colors.yellow('Checking energy after check-in...')}`);
          const nftStats = await checkNFTStats(sessionData.page, walletAddress);
          if (nftStats.success && nftStats.data && nftStats.data.pending_energy > 0) {
            console.log(`${colors.green('There is')} ${colors.white(nftStats.data.pending_energy.toFixed(2))} ${colors.green('Energy to collect')}`);
            const collectResult = await collectEnergy(sessionData.page, walletAddress, privateKey);
            if (collectResult.success) {
              const { total_nfts, success_count, failed_count, total_energy } = collectResult.data;
              console.log(`${colors.green('✓ Collect successful:')} ${colors.white(total_energy.toFixed(2))} ${colors.green('energy from')} ${colors.white(success_count)}/${colors.white(total_nfts)} ${colors.green('NFTs')}`);
              if (failed_count > 0) {
                console.log(`${colors.yellow('⚠ There is')} ${colors.white(failed_count)} ${colors.yellow('NFTs error')}`);
              }
            } else {
              console.log(`${colors.red('✗ Collect failed')}`);
            }
          } else {
            console.log(`${colors.gray('Not enough energy to collect (')}${colors.white(nftStats.data?.pending_energy ? nftStats.data.pending_energy.toFixed(2) : 0)}${colors.gray(')')}`);
          }
        } else {
          console.log(`${colors.red('✗ Check-in failed')}`);
        }
      } else {
        console.log(`${colors.gray('Already checked in today')}`);
        markAsCheckedIn(wallet);
      }
    } else {
      console.log(`${colors.gray('Skip - already checked in today')}`);
    }
    await sessionData.browser.close();
    return true;
  } catch (error) {
    console.log(`${colors.red('Processing Error:')} ${error.message}`);
    if (sessionData && sessionData.browser) await sessionData.browser.close();
    return false;
  }
}

async function processBoxOpen(wallet, proxyString, walletIndex, totalWallets) {
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
    sessionData = await getBrowserSession(proxyConfig, wallet.userAgent, 'https://bubuverse.fun/space');
    wallet.vcrcsCookie = sessionData.vcrcsCookie;
    wallet.allCookies = sessionData.cookies;
    wallet.cookieCreatedAt = new Date().toISOString();
    wallet.cookieExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    wallet.deviceId = sessionData.deviceId || uuidv4().replace(/-/g, '');
    console.log(`${colors.green('Cookies OK')}`);
  } catch (error) {
    console.log(`${colors.red('Cookies Error:')} ${error.message}`);
    return false;
  }

  try {
    console.log(`${colors.yellow('Checking boxes...')}`);
    const boxes = await getBoxes(sessionData.page, walletAddress);
    if (boxes.length === 0) {
      console.log(`${colors.gray('No boxes')}`);
      await sessionData.browser.close();
      return true;
    }

    console.log(`${colors.green('Found')} ${colors.white(boxes.length)} ${colors.green('boxes')}`);
    if (!openData[walletAddress]) openData[walletAddress] = [];

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      const boxId = box.id;
      try {
        console.log(`${colors.yellow('Opening box')} ${colors.white(i + 1)}/${colors.white(boxes.length)}...`);
        const result = await openBox(sessionData.page, walletAddress, privateKey, boxId);
        const templateId = result.template_id;
        openData[walletAddress].push(templateId);
        const nftInfo = getNFTInfo(templateId);
        console.log(nftInfo.color(`  → ${nftInfo.rarity} - ${nftInfo.name}`));
        successCount++;
        if (i < boxes.length - 1) await sleep(2000);
      } catch (error) {
        console.log(`  → ${colors.red('Error:')} ${error.message}`);
        failCount++;
        if (i < boxes.length - 1) await sleep(2000);
      }
    }

    console.log(`${colors.green('Completed:')} ${colors.white(successCount)} ${colors.green('OK')}, ${colors.white(failCount)} ${colors.red('errors')}`);
    fs.writeFileSync(openFile, JSON.stringify(openData, null, 2));
    await sessionData.browser.close();
    return true;
  } catch (error) {
    console.log(`${colors.red('Processing Error:')} ${error.message}`);
    if (sessionData && sessionData.browser) await sessionData.browser.close();
    return false;
  }
}

async function processNFTStake(wallet, proxyString, walletIndex, totalWallets) {
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
    sessionData = await getBrowserSession(proxyConfig, wallet.userAgent, 'https://bubuverse.fun/space');
    console.log(`${colors.green('Cookies OK')}`);
  } catch (error) {
    console.log(`${colors.red('Cookies Error:')} ${error.message}`);
    return false;
  }

  try {
    if (!hasNFTs(walletAddress)) {
      console.log(`${colors.gray('No NFTs to stake')}`);
      await sessionData.browser.close();
      return true;
    }
    if (isAlreadyStaked(walletAddress)) {
      console.log(`${colors.gray('NFTs already staked')}`);
      await sessionData.browser.close();
      return true;
    }

    console.log(`${colors.yellow('Staking NFTs...')}`);
    const stakeResult = await stakeNFTs(sessionData.page, walletAddress, privateKey);
    if (stakeResult.success) {
      const { total_nfts, success_count, failed_count } = stakeResult.data;
      console.log(`${colors.green('Stake successful:')} ${colors.white(success_count)}/${colors.white(total_nfts)} ${colors.green('NFTs')}`);
      if (failed_count > 0) {
        console.log(`${colors.red('Error:')} ${colors.white(failed_count)} ${colors.red('NFTs failed')}`);
        if (stakeResult.data.error_messages && stakeResult.data.error_messages.length > 0) {
          stakeResult.data.error_messages.forEach(msg => {
            console.log(`  → ${colors.red(msg)}`);
          });
        }
      }
      markAsStaked(walletAddress, { total_nfts, success_count, failed_count, timestamp: new Date().toISOString() });
      fs.writeFileSync(openFile, JSON.stringify(openData, null, 2));
    } else {
      console.log(`${colors.red('Stake failed')}`);
    }
    await sessionData.browser.close();
    return true;
  } catch (error) {
    console.log(`${colors.red('Staking Error:')} ${error.message}`);
    if (sessionData && sessionData.browser) await sessionData.browser.close();
    return false;
  }
}

async function processWallets(mode) {
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

  console.log(`${colors.green(`Processing ${mode} for`)} ${colors.white(wallets.length)} ${colors.green('wallets with')} ${colors.white(proxies.length)} ${colors.green('proxies')}`);

  console.log(`\n${colors.yellow('Preprocessing wallets...')}`);
  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    delete wallet.createdAt;
    delete wallet.cookieExpiresAt;
    delete wallet.cookieCreatedAt;
    delete wallet.vcrcsCookie;
    delete wallet.allCookies;
    if (!wallet.deviceId) wallet.deviceId = uuidv4().replace(/-/g, '');
    if (!wallet.userAgent) wallet.userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
  }
  fs.writeFileSync(walletFile, JSON.stringify(wallets, null, 2));
  console.log(`${colors.green('Preprocessing completed')}\n`);

  let totalProcessed = 0;
  let totalErrors = 0;
  let totalSkipped = 0;

  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    const proxy = proxies[i];

    if (mode === 'Box Open' && hasNFTs(wallet.publicKey) && isAlreadyStaked(wallet.publicKey)) {
      const nftInfo = getNFTInfo(openData[wallet.publicKey][0]);
      console.log(`\n[${i + 1}/${wallets.length}] ${colors.cyan(wallet.publicKey.substring(0, 8))}...`);
      console.log(`${colors.gray('Skipping - already has')} ${nftInfo.color(nftInfo.rarity)}`);
      totalSkipped++;
      await sleep(1000);
      continue;
    }

    if (mode === 'NFT Stake') {
      if (isAlreadyStaked(wallet.publicKey)) {
        console.log(`\n[${i + 1}/${wallets.length}] ${colors.cyan(wallet.publicKey.substring(0, 8))}...`);
        console.log(`${colors.gray('Skipping - already staked')}`);
        totalSkipped++;
        await sleep(1000);
        continue;
      }
      if (!hasNFTs(wallet.publicKey)) {
        console.log(`\n[${i + 1}/${wallets.length}] ${colors.cyan(wallet.publicKey.substring(0, 8))}...`);
        console.log(`${colors.gray('Skipping - no NFTs')}`);
        totalSkipped++;
        await sleep(1000);
        continue;
      }
    }

    let processedSuccessfully = false;
    if (mode === 'DailyCheckIn') {
      processedSuccessfully = await processDailyCheckIn(wallet, proxy, i, wallets.length);
    } else if (mode === 'Box Open') {
      processedSuccessfully = await processBoxOpen(wallet, proxy, i, wallets.length);
    } else if (mode === 'NFT Stake') {
      processedSuccessfully = await processNFTStake(wallet, proxy, i, wallets.length);
    }

    if (processedSuccessfully) {
      totalProcessed++;
    } else {
      totalErrors++;
    }

    fs.writeFileSync(walletFile, JSON.stringify(wallets, null, 2));
    if (i < wallets.length - 1) {
      console.log(`${colors.gray('Waiting 3s...')}`);
      await sleep(3000);
    }
  }

  console.log(`\n${colors.cyan('Summary:')}`);
  console.log(`${colors.green('Processed:')} ${colors.white(totalProcessed)}/${colors.white(wallets.length)} ${colors.green('wallets')}`);
  console.log(`${colors.gray('Skipped:')} ${colors.white(totalSkipped)} ${colors.gray('wallets')}`);
  console.log(`${colors.red('Errors:')} ${colors.white(totalErrors)} ${colors.red('wallets')}`);
  if (mode === 'Box Open') showBoxStats();
  if (mode === 'NFT Stake') showStakeStats(totalProcessed, totalSkipped, totalErrors);
}

function showBoxStats() {
  console.log(`\n${colors.cyan('=== Box Statistics ===')}`);
  if (Object.keys(openData).length === 0) {
    console.log(`${colors.gray('No data yet')}`);
    return;
  }

  let totalBoxes = 0;
  const rarityCount = { '10x': 0, '100x': 0, '1000x': 0 };
  for (const [, templates] of Object.entries(openData)) {
    templates.forEach(template => {
      const templateId = typeof template === 'string' ? template : template.templateId;
      totalBoxes++;
      const nftInfo = getNFTInfo(templateId);
      if (nftInfo.rarity.includes('10x')) rarityCount['10x']++;
      else if (nftInfo.rarity.includes('100x')) rarityCount['100x']++;
      else if (nftInfo.rarity.includes('1000x')) rarityCount['1000x']++;
    });
  }

  console.log(`${colors.green('NFT 10x:')} ${colors.white(rarityCount['10x'])}`);
  console.log(`${colors.yellow('NFT 100x:')} ${colors.white(rarityCount['100x'])}`);
  console.log(`${colors.magenta('NFT 1000x:')} ${colors.white(rarityCount['1000x'])}`);
  console.log(`${colors.blue('Total boxes:')} ${colors.white(totalBoxes)}`);
}

function showStakeStats(totalStaked, totalSkipped, totalErrors) {
  console.log(`\n${colors.cyan('=== Stake Statistics ===')}`);
  if (Object.keys(openData).length === 0) {
    console.log(`${colors.gray('No data yet')}`);
    return;
  }

  let totalWallets = 0;
  let walletsWithStakedNFTs = 0;
  let totalNFTs = 0;
  let totalStakedNFTs = 0;

  for (const [, nfts] of Object.entries(openData)) {
    totalWallets++;
    let walletStakedCount = 0;
    nfts.forEach(nft => {
      totalNFTs++;
      if (typeof nft === 'object' && nft.staked) {
        walletStakedCount++;
        totalStakedNFTs++;
      }
    });
    if (walletStakedCount > 0) walletsWithStakedNFTs++;
  }

  console.log(`${colors.green('Wallets with staked NFTs:')} ${colors.white(walletsWithStakedNFTs)}/${colors.white(totalWallets)}`);
  console.log(`${colors.green('Staked NFTs:')} ${colors.white(totalStakedNFTs)}/${colors.white(totalNFTs)}`);
  console.log(`${colors.blue('This session:')} ${colors.white(totalStaked)} ${colors.green('staked')}, ${colors.white(totalSkipped)} ${colors.gray('skipped')}, ${colors.white(totalErrors)} ${colors.red('errors')}`);
}

function showMenu() {
  console.log(`${colors.cyan('=== BUBUVERSE AUTOMATION TOOL ===')}`);
  console.log(`${colors.green('Loaded')} ${colors.white(proxies.length)} ${colors.green('proxies,')} ${colors.white(userAgents.length)} ${colors.green('user agents')}\n`);
  console.log(`${colors.yellow('Select an option:')}`);
  console.log(`${colors.white('1.')} DailyCheckIn`);
  console.log(`${colors.white('2.')} Box Open`);
  console.log(`${colors.white('3.')} NFT Stake`);
  console.log(`${colors.white('4.')} Exit`);
}

async function main() {
  while (true) {
    showMenu();
    const choice = readline.question(`${colors.cyan('Enter your choice (1-4): ')}`);
    let mode;
    if (choice === '1') mode = 'DailyCheckIn';
    else if (choice === '2') mode = 'Box Open';
    else if (choice === '3') mode = 'NFT Stake';
    else if (choice === '4') {
      console.log(`${colors.green('Exiting...')}`);
      break;
    } else {
      console.log(`${colors.red('Invalid choice! Please select 1, 2, 3, or 4.')}`);
      continue;
    }
    await processWallets(mode);
    console.log(`\n${colors.green(`Completed ${mode}!`)}`);
    console.log(`${colors.yellow('Press Enter to return to menu...')}`);
    readline.question();
  }
}

main();

process.on('SIGINT', () => {
  console.log(`\n\n${colors.yellow('Saving data...')}`);
  fs.writeFileSync(walletFile, JSON.stringify(JSON.parse(fs.readFileSync(walletFile, 'utf-8')), null, 2));
  fs.writeFileSync(openFile, JSON.stringify(openData, null, 2));
  console.log(`${colors.green('Saved wallet_sol.json and open.json')}`);
  process.exit(0);
});
