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
                    'accept': '*/*'
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
                    'accept': '*/*'
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
                    'accept': '*/*'
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
                    'content-type': 'application/json'
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
    if (!wallet.DailyCheckin) return false;
    
    const today = new Date().toDateString();
    const lastCheckin = new Date(wallet.DailyCheckin).toDateString();
    
    return today === lastCheckin;
}

function markAsCheckedIn(wallet) {
    wallet.DailyCheckin = new Date().toISOString();
}

async function processWallet(wallet, proxyString, walletIndex, totalWallets) {
  const { privateKey, publicKey } = wallet;
  const walletAddress = publicKey;

  console.log(`\n[${walletIndex + 1}/${totalWallets}] ${walletAddress.substring(0, 8)}...`);

  let proxyConfig = null;
  try {
    proxyConfig = parseProxy(proxyString);
    console.log(`Proxy: ${proxyConfig.host}:${proxyConfig.port}`);
  } catch (error) {
    console.log(`Lỗi proxy: ${error.message}`);
    return false;
  }

  let sessionData = null;
  try {
    console.log(`Đang tạo session...`);
    sessionData = await getBrowserSession(proxyConfig, wallet.userAgent);
    console.log(`Session OK`);

  } catch (error) {
    console.log(`Lỗi session: ${error.message}`);
    return false;
  }

  try {
    if (!isAlreadyCheckedInToday(wallet)) {
      console.log(`Đang kiểm tra daily check-in...`);
      const checkInStatus = await checkDailyStatus(sessionData.page, walletAddress);
      
      if (checkInStatus.can_check_in) {
        console.log(`Đang thực hiện daily check-in...`);
        const checkInResult = await performDailyCheckIn(sessionData.page, walletAddress);
        
        if (checkInResult.success) {
          console.log(`✓ Check-in thành công! Nhận ${checkInResult.energy_reward} energy (Day ${checkInResult.check_in_count})`);
          markAsCheckedIn(wallet);
        } else {
          console.log(`✗ Check-in thất bại`);
        }
      } else {
        console.log(`Đã check-in hôm nay rồi`);
        markAsCheckedIn(wallet);
      }
    } else {
      console.log(`Bỏ qua check-in - đã thực hiện hôm nay`);
    }

    console.log(`Đang kiểm tra energy...`);
    const nftStats = await checkNFTStats(sessionData.page, walletAddress);
    
    if (nftStats.pending_energy && nftStats.pending_energy > 1000) {
      console.log(`Có ${nftStats.pending_energy.toFixed(2)} energy để collect`);
      
      const collectResult = await collectEnergy(sessionData.page, walletAddress, privateKey);
      
      if (collectResult.success) {
        const { total_nfts, success_count, failed_count, total_energy } = collectResult.data;
        console.log(`✓ Collect thành công: ${total_energy.toFixed(2)} energy từ ${success_count}/${total_nfts} NFTs`);
        
        if (failed_count > 0) {
          console.log(`⚠ Có ${failed_count} NFTs lỗi`);
          if (collectResult.data.error_messages && collectResult.data.error_messages.length > 0) {
            collectResult.data.error_messages.forEach(msg => {
              console.log(`  → ${msg}`);
            });
          }
        }
      } else {
        console.log(`✗ Collect thất bại`);
      }
    } else {
      console.log(`Energy không đủ để collect (${nftStats.pending_energy ? nftStats.pending_energy.toFixed(2) : 0})`);
    }

    await sessionData.browser.close();
    return true;
  } catch (error) {
    console.log(`Lỗi xử lý: ${error.message}`);
    if (sessionData && sessionData.browser) {
      await sessionData.browser.close();
    }
    return false;
  }
}

async function processDailyTasks() {
  if (!fs.existsSync(walletFile)) {
    console.log(`File ${walletFile} không tồn tại!`);
    return;
  }

  const walletRawData = JSON.parse(fs.readFileSync(walletFile, 'utf-8'));
  const wallets = Array.isArray(walletRawData) ? walletRawData : [];

  if (wallets.length === 0) {
    console.log('Không có ví nào trong file!');
    return;
  }

  if (wallets.length > proxies.length) {
    console.log(`Không đủ proxy! Cần ${wallets.length}, có ${proxies.length}`);
    return;
  }

  console.log(`Thực hiện daily tasks cho ${wallets.length} ví với ${proxies.length} proxy`);

  console.log(`\nKiểm tra wallets...`);
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
  console.log(`Kiểm tra hoàn tất\n`);

  let totalProcessed = 0;
  let totalCheckedIn = 0;
  let totalCollected = 0;
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
      console.log(`Chờ 3s...`);
      await sleep(3000);
    }
  }
  
  console.log(`\nTổng kết:`);
  console.log(`Đã xử lý: ${totalProcessed}/${wallets.length} ví`);
  console.log(`Lỗi: ${totalErrors} ví`);
  console.log(`\nHoàn tất daily tasks!`);
}

console.log(`Daily Tools`);
console.log(`Tải ${proxies.length} proxies, ${userAgents.length} user agents\n`);

processDailyTasks();

process.on('SIGINT', () => {
  console.log(`\n\nĐang lưu dữ liệu...`);
  const walletRawData = JSON.parse(fs.readFileSync(walletFile, 'utf-8'));
  fs.writeFileSync(walletFile, JSON.stringify(walletRawData, null, 2));
  console.log(`Đã lưu wallet_sol.json`);
  process.exit(0);
});