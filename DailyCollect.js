const fs = require('fs');
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

async function getBrowserSession(proxyConfig, userAgent) {
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

        const targetUrl = `https://bubuverse.fun/tasks`;
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

        return {
            page: page,
            browser: browser,
            cookies: cookieString
        };

    } catch (error) {
        if (browser) {
            await browser.close();
        }
        throw error;
    }
}

async function checkDailyStatus(page, walletAddress) {
    try {
        const timestamp = Date.now();
        const apiUrl = `https://bubuverse.fun/api/users/${walletAddress}/check-in-status?_t=${timestamp}`;
        
        const response = await page.evaluate(async (url) => {
            const response = await fetch(url, {
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
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            return await response.json();
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
            const response = await fetch(url, {
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
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            return await response.json();
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
            const response = await fetch(url, {
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
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            return await response.json();
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

        const body = {
            signature: signature,
            message: message
        };

        const apiUrl = `https://bubuverse.fun/api/users/${walletAddress}/nfts/collect-energy`;
        
        const response = await page.evaluate(async (url, requestBody) => {
            const response = await fetch(url, {
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
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            return await response.json();
        }, apiUrl, body);

        return response;
    } catch (error) {
        throw new Error(`Failed to collect energy: ${error.message}`);
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
    sessionData = await getBrowserSession(proxyConfig, wallet.userAgent);
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
    if (sessionData && sessionData.browser) {
      await sessionData.browser.close();
    }
    return false;
  }
}

async function processDailyTasks() {
  if (!fs.existsSync(walletFile)) {
    console.log(`${colors.red('File')} ${colors.white(walletFile)} ${colors.red('Does not exist!')}`);
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

  console.log(`${colors.green('Performing daily tasks for')} ${colors.white(wallets.length)} ${colors.green('wallets with')} ${colors.white(proxies.length)} ${colors.green('proxies')}`);

  console.log(`\n${colors.yellow('Checking wallets...')}`);
  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];

    if (!wallet.deviceId) {
      wallet.deviceId = uuidv4().replace(/-/g, '');
    }
    if (!wallet.userAgent) {
      wallet.userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
    }
  }
  fs.writeFileSync(walletFile, JSON.stringify(wallets, null, 2));
  console.log(`${colors.green('Check completed')}\n`);

  let totalProcessed = 0;
  let totalErrors = 0;

  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    const proxy = proxies[i];

    const processedSuccessfully = await processWallet(wallet, proxy, i, wallets.length);
    
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
  console.log(`${colors.red('Errors:')} ${colors.white(totalErrors)} ${colors.red('wallets')}`);
  console.log(`\n${colors.green('Completed daily tasks!')}`);
}

console.log(`${colors.cyan('DAILY TASKS TOOL')}`);
console.log(`${colors.green('Loaded')} ${colors.white(proxies.length)} ${colors.green('proxies,')} ${colors.white(userAgents.length)} ${colors.green('user agents')}\n`);

processDailyTasks();

process.on('SIGINT', () => {
  console.log(`\n\n${colors.yellow('Saving data...')}`);
  const walletRawData = JSON.parse(fs.readFileSync(walletFile, 'utf-8'));
  fs.writeFileSync(walletFile, JSON.stringify(walletRawData, null, 2));
  console.log(`${colors.green('Saved wallet_sol.json')}`);
  process.exit(0);
});
