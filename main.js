const fs = require('fs');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { v4: uuidv4 } = require('uuid');
const readline = require('readline-sync');
const colors = require('colors');
const bip39 = require('bip39');
const ed25519 = require('ed25519-hd-key');
const bs58 = require('bs58');
const { Keypair } = require('@solana/web3.js');

puppeteer.use(StealthPlugin());

const proxies = fs.readFileSync('proxy.txt', 'utf-8').split('\n').filter(Boolean);

let userAgents = [];
if (!fs.existsSync('ua.txt') || fs.readFileSync('ua.txt', 'utf-8').trim() === '') {
  const generated = [];
  for (let i = 0; i < 1000; i++) {
    const ver = Math.floor(Math.random() * 50) + 70;
    const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver}.0.${Math.floor(Math.random()*5000)}.0 Safari/537.36`;
    generated.push(ua);
  }
  fs.writeFileSync('ua.txt', generated.join('\n'));
  userAgents = generated;
} else {
  userAgents = fs.readFileSync('ua.txt', 'utf-8').split('\n').filter(Boolean);
}

const walletFile = 'wallet_sol.json';
let walletData = [];

if (fs.existsSync(walletFile)) {
  const data = JSON.parse(fs.readFileSync(walletFile, 'utf-8'));
  walletData = Array.isArray(data) ? data : [];
}

const referrerAddress = readline.question(colors.yellow('Nhập referrerAddress: '));
const count = parseInt(readline.question(colors.yellow('Nhập số lượng ví muốn tạo: ')));

const sleep = ms => new Promise(res => setTimeout(res, ms));

function parseProxy(proxyString) {
  const match = proxyString.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
  if (match) {
    return {
      host: match[3],
      port: parseInt(match[4]),
      username: match[1],
      password: match[2]
    };
  }
  const parts = proxyString.split(':');
  if (parts.length === 4) {
    return {
      host: parts[0],
      port: parseInt(parts[1]),
      username: parts[2],
      password: parts[3]
    };
  }
  throw new Error(`Invalid proxy format: ${proxyString}`);
}

(async () => {
  console.log(colors.blue(`🔍 Đã load ${proxies.length} proxy và ${userAgents.length} user agents`));
  console.log(colors.yellow(`⚠️  Mỗi ví sẽ sử dụng 1 proxy riêng biệt để tránh bị ban IP`));
  
  for (let i = 0; i < count; i++) {
    console.log(colors.cyan(`\n[${i + 1}/${count}] === TẠO VÍ MỚI ===`));

    if (i >= proxies.length) {
      console.log(colors.red(`[!] Hết proxy! Chỉ có ${proxies.length} proxy cho ${count} ví`));
      break;
    }

    const proxyString = proxies[i].trim();
    const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
    const deviceId = uuidv4().replace(/-/g, '');

    const mnemonic = bip39.generateMnemonic(128);
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const path = "m/44'/501'/0'/0'";
    const derived = ed25519.derivePath(path, seed.toString('hex')).key;
    const keypair = Keypair.fromSeed(derived);

    const publicKey = keypair.publicKey.toBase58();
    const privateKey = bs58.encode(keypair.secretKey);

    console.log(`🌐 Đang tạo ví: ${publicKey}`);
    console.log(`↳ Proxy riêng #${i + 1}: ${proxyString}`);
    console.log(`↳ Device ID: ${deviceId}`);

    try {
      const proxyConfig = parseProxy(proxyString);
      
      const browser = await puppeteer.launch({
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
      await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });

      await new Promise(r => setTimeout(r, 20000));

      const cookies = await page.cookies();
      const vcrcsCookie = cookies.find(c => c.name === '_vcrcs');
      
      if (!vcrcsCookie) {
        throw new Error("Không tìm thấy cookie _vcrcs!");
      }

      const response = await page.evaluate(async ({ publicKey, referrerAddress, deviceId, cookieValue }) => {
        try {
          const res = await fetch('https://bubuverse.fun/api/users', {
            method: 'POST',
            headers: {
              'accept': '*/*',
              'accept-language': 'vi-VN,vi;q=0.9',
              'content-type': 'application/json',
              'user-agent': navigator.userAgent,
              'referer': location.href,
              'origin': 'https://bubuverse.fun',
              'cookie': `_vcrcs=${cookieValue}`
            },
            body: JSON.stringify({
              walletAddress: publicKey,
              referrerAddress,
              deviceId
            })
          });

          const responseText = await res.text();
          let json;
          try {
            json = JSON.parse(responseText);
          } catch (e) {
            json = { error: 'Invalid JSON response', raw: responseText.substring(0, 200) };
          }

          return { status: res.status, ok: res.ok, body: json };
        } catch (error) {
          return { status: 0, ok: false, body: { error: error.message } };
        }
      }, { publicKey, referrerAddress, deviceId, cookieValue: vcrcsCookie.value });

      if (response.ok) {
        const wallet = {
          mnemonic,
          privateKey,
          publicKey,
          deviceId,
          userAgent
        };
        walletData.push(wallet);
        fs.writeFileSync(walletFile, JSON.stringify(walletData, null, 2));
        console.log(colors.green(`[+] Thành công! Ví: ${publicKey}`));
      } else {
        console.log(colors.red(`[!] Lỗi từ server: ${response.status}`));
        console.log(colors.gray('Response:', JSON.stringify(response.body, null, 2)));
      }

      await browser.close();

      if (global.gc) {
        global.gc();
      }
    } catch (err) {
      console.log(colors.red(`[!] Lỗi khi tạo ví: ${err.message || err}`));
    }

    const delayTime = Math.random() * 7000 + 5000;
    console.log(colors.gray(`⏳ Nghỉ ${Math.round(delayTime/1000)}s...`));
    await sleep(delayTime);
  }

  console.log(colors.green('\n✅ Hoàn tất. Ví đã lưu vào wallet_sol.json'));
  console.log(colors.cyan(`📊 Tổng cộng đã tạo: ${walletData.length} ví`));
})();
