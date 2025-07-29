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
const openFile = 'open.json';
let openData = {};

if (fs.existsSync(openFile)) {
  try {
    openData = JSON.parse(fs.readFileSync(openFile, 'utf-8'));
  } catch (err) {
    openData = {};
    console.log(`${colors.yellow('[!] Lỗi đọc open.json, tạo mới.')}`);
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

async function stakeNFTs(page, walletAddress, privateKey) {
    try {
        const timestamp = Date.now();
        const message = `Stake NFTs at ${timestamp}`;
        const signature = signMessage(message, privateKey);

        const body = {
            signature: signature,
            message: message
        };

        const apiUrl = `https://bubuverse.fun/api/users/${walletAddress}/nfts/stake`;
        
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
        throw new Error(`Failed to stake NFTs: ${error.message}`);
    }
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
  if (!openData[walletAddress]) {
    openData[walletAddress] = [];
  }
  
  // Convert string NFTs to objects and mark as staked
  openData[walletAddress] = openData[walletAddress].map(nft => {
    if (typeof nft === 'string') {
      return {
        templateId: nft,
        staked: true,
        stakedAt: new Date().toISOString(),
        stakeResult: stakeResult
      };
    } else if (typeof nft === 'object' && !nft.staked) {
      return {
        ...nft,
        staked: true,
        stakedAt: new Date().toISOString(),
        stakeResult: stakeResult
      };
    }
    return nft;
  });
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
    console.log(`${colors.red('Lỗi proxy:')} ${error.message}`);
    return false;
  }

  let sessionData = null;
  try {
    console.log(`${colors.yellow('Đang lấy cookies...')}`);
    sessionData = await getBrowserSession(proxyConfig, wallet.userAgent);
    console.log(`${colors.green('Cookies OK')}`);

  } catch (error) {
    console.log(`${colors.red('Lỗi Cookies:')} ${error.message}`);
    return false;
  }

  try {
    // Check if wallet has NFTs
    if (!hasNFTs(walletAddress)) {
      console.log(`${colors.gray('Không có NFT để stake')}`);
      await sessionData.browser.close();
      return true;
    }

    // Check if already staked
    if (isAlreadyStaked(walletAddress)) {
      console.log(`${colors.gray('NFTs đã được stake rồi')}`);
      await sessionData.browser.close();
      return true;
    }

    console.log(`${colors.yellow('Đang stake NFTs...')}`);
    const stakeResult = await stakeNFTs(sessionData.page, walletAddress, privateKey);

    if (stakeResult.success) {
      const { total_nfts, success_count, failed_count } = stakeResult.data;
      console.log(`${colors.green('Stake thành công:')} ${colors.white(success_count)}/${colors.white(total_nfts)} ${colors.green('NFTs')}`);

      if (failed_count > 0) {
        console.log(`${colors.red('Lỗi:')} ${colors.white(failed_count)} ${colors.red('NFTs thất bại')}`);
        if (stakeResult.data.error_messages && stakeResult.data.error_messages.length > 0) {
          stakeResult.data.error_messages.forEach(msg => {
            console.log(`  → ${colors.red(msg)}`);
          });
        }
      }
      
      // Mark NFTs as staked in open.json
      markAsStaked(walletAddress, {
        total_nfts,
        success_count,
        failed_count,
        timestamp: new Date().toISOString()
      });
      
      fs.writeFileSync(openFile, JSON.stringify(openData, null, 2));
      
    } else {
      console.log(`${colors.red('Stake thất bại')}`);
    }

    await sessionData.browser.close();
    return true;
  } catch (error) {
    console.log(`${colors.red('Lỗi stake:')} ${error.message}`);
    if (sessionData && sessionData.browser) {
      await sessionData.browser.close();
    }
    return false;
  }
}

async function processStaking() {
  if (!fs.existsSync(walletFile)) {
    console.log(`${colors.red('File')} ${colors.white(walletFile)} ${colors.red('không tồn tại!')}`);
    return;
  }

  const walletRawData = JSON.parse(fs.readFileSync(walletFile, 'utf-8'));
  const wallets = Array.isArray(walletRawData) ? walletRawData : [];

  if (wallets.length === 0) {
    console.log(`${colors.red('Không có ví nào trong file!')}`);
    return;
  }

  if (wallets.length > proxies.length) {
    console.log(`${colors.red('Không đủ proxy! Cần')} ${colors.white(wallets.length)}${colors.red(', có')} ${colors.white(proxies.length)}`);
    return;
  }

  console.log(`${colors.green('Stake NFTs cho')} ${colors.white(wallets.length)} ${colors.green('ví với')} ${colors.white(proxies.length)} ${colors.green('proxy')}`);

  console.log(`\n${colors.yellow('Kiểm tra wallets...')}`);
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
  console.log(`${colors.green('Kiểm tra hoàn tất')}\n`);

  let totalStaked = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    const proxy = proxies[i];

    // Check if already staked
    if (isAlreadyStaked(wallet.publicKey)) {
        console.log(`\n[${i + 1}/${wallets.length}] ${colors.cyan(wallet.publicKey.substring(0, 8))}...`);
        console.log(`${colors.gray('Bỏ qua - đã stake rồi')}`);
        totalSkipped++;
        await sleep(1000);
        continue;
    }

    // Check if has NFTs
    if (!hasNFTs(wallet.publicKey)) {
        console.log(`\n[${i + 1}/${wallets.length}] ${colors.cyan(wallet.publicKey.substring(0, 8))}...`);
        console.log(`${colors.gray('Bỏ qua - không có NFT')}`);
        totalSkipped++;
        await sleep(1000);
        continue;
    }

    const processedSuccessfully = await processWallet(wallet, proxy, i, wallets.length);
    
    if (processedSuccessfully) {
      if (isAlreadyStaked(wallet.publicKey)) {
        totalStaked++;
      }
    } else {
      totalErrors++;
    }

    fs.writeFileSync(walletFile, JSON.stringify(wallets, null, 2));

    if (i < wallets.length - 1) {
      console.log(`${colors.gray('Chờ 3s...')}`);
      await sleep(3000);
    }
  }

  showStats(totalStaked, totalSkipped, totalErrors);
  console.log(`\n${colors.green('Hoàn tất!')}`);
}

function showStats(totalStaked = 0, totalSkipped = 0, totalErrors = 0) {
  if (Object.keys(openData).length === 0) {
    console.log(`${colors.gray('Chưa có dữ liệu')}`);
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

    if (walletStakedCount > 0) {
      walletsWithStakedNFTs++;
    }
  }

  console.log(`\n${colors.cyan('Tổng kết:')}`);
  console.log(`${colors.green('Ví có NFT đã stake:')} ${colors.white(walletsWithStakedNFTs)}/${colors.white(totalWallets)}`);
  console.log(`${colors.green('NFTs đã stake:')} ${colors.white(totalStakedNFTs)}/${colors.white(totalNFTs)}`);

  if (totalStaked > 0 || totalSkipped > 0 || totalErrors > 0) {
    console.log(`${colors.blue('Phiên này:')} ${colors.white(totalStaked)} ${colors.green('stake')}, ${colors.white(totalSkipped)} ${colors.gray('bỏ qua')}, ${colors.white(totalErrors)} ${colors.red('lỗi')}`);
  }
}

console.log(`${colors.cyan('NFT STAKING TOOL')}`);
console.log(`${colors.green('Tải')} ${colors.white(proxies.length)} ${colors.green('proxies,')} ${colors.white(userAgents.length)} ${colors.green('user agents')}\n`);

processStaking();

process.on('SIGINT', () => {
  console.log(`\n\n${colors.yellow('Đang lưu dữ liệu...')}`);
  fs.writeFileSync(openFile, JSON.stringify(openData, null, 2));
  console.log(`${colors.green('Đã lưu open.json')}`);
  showStats();
  process.exit(0);
});
