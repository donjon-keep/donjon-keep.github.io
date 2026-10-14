// DONJON public miner — work-to-mint, mainnet (Base) — multi-core grinds with Node's cluster.
//   node miner.js <your_address> [--workers N] [--solves M] [--out dir]
// Signs NOTHING. Finds solves for the CURRENT epoch and writes them as JSON; the miner
// then submits with THEIR OWN wallet (or any web3 wallet):
//   minedMint(bytes32 salt, uint256 nonce)   payable    e.g. { value: "0x…" }  with the deposit of your choice
// to contract 0x67F93E8b7141D32C316C4DC7456f9f0c214702C6 (source verified on Basescan).
//
// Verified machine facts (v6 source, Basescan-checked):
//   digest = keccak256(abi.encodePacked(salt, nonce, msg.sender, epoch)) ; epoch = totalSolves at call time
//   valid when uint(digest) < mineTarget (deployed = 2^232 => 1 in 2^24 hashes per solve)
//   SOLVES ARE PER-MINER: msg.sender is inside the domain — no one can steal, share, or reuse your solve.
//   Epoch rotates by exactly 1 per solved mint; a stale solve after anyone's mint = invalid — grind again.
//   Retail mint entry = 100.50% of NAV (0.25% lock + 0.25% creator). Mined entry = 100.25% (lock fee waived).
//   Your FULL deposit always enters the pool (floorPool += msg.value). Tokens redeemable at NAV any time.
// Speed, measured (this file, Node js-sha3): single core ~97k H/s; a core pool multiplies that.
const cluster = require('cluster');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { keccak256 } = require('js-sha3');
const { ethers } = require('ethers');

const CONTRACT = '0x67F93E8b7141D32C316C4DC7456f9f0c214702C6';
const RPCS = ['https://mainnet.base.org'];
const ABI_MIN = ['function mineTarget() view returns (uint256)', 'function totalSolves() view returns (uint256)'];

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
};
const MINER = process.argv[2];
if (!MINER || !ethers.isAddress(MINER)) { console.error('usage: node miner.js <your_miner_address> [--workers N] [--solves M] [--out dir]'); process.exit(1); }
const WORKERS = Math.max(1, Math.min(parseInt(arg('workers', String(Math.max(1, os.cpus().length - 1))), 10), 32));
const SOLVES = parseInt(arg('solves', '1'), 10);
const OUT = arg('out', 'donjon_solves');

function preimageHex(salt, nonce, miner, epoch) {
  return salt.slice(2) + nonce.toString(16).padStart(64, '0') + miner.slice(2).toLowerCase() + String(epoch).padStart(64, '0');
}

if (cluster.isPrimary) {
  const provider = new ethers.JsonRpcProvider(RPCS[0]);
  const c = new ethers.Contract(CONTRACT, ABI_MIN, provider);
  fs.mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();
  (async () => {
    for (let s = 0; s < SOLVES; s++) {
      const target = await c.mineTarget();
      const epoch = Number(await c.totalSolves());
      const file = path.join(OUT, `solve_${epoch}.json`);
      if (fs.existsSync(file)) { console.log('epoch', epoch, 'already solved in this folder — skipping'); continue; }
      const salt = ethers.hexlify(ethers.randomBytes(32));
      console.log(`epoch ${epoch}: grinding across ${WORKERS} cores …`);
      cluster.fork({ WORKER: '1', W_TARGET: target.toString(), W_SALT: salt, W_EPOCH: String(epoch), W_MINER: MINER, N: String(WORKERS) });
      const result = await new Promise((resolve) => {
        const onMsg = (m) => { if (m.solve) { for (const id in cluster.workers) { try { cluster.workers[id].kill(); } catch {} } cluster.off('message', onMsg); resolve(m.solve); } };
        cluster.on('message', onMsg);
        setTimeout(() => resolve(null), 1000 * 3600);
      });
      if (!result) { console.error('grind interrupted'); process.exit(1); }
      const ms = Date.now() - result.t0;
      fs.writeFileSync(file, JSON.stringify({ contract: CONTRACT, miner: MINER, epoch: result.epoch, salt: result.salt, nonce: result.nonce, ms, when: new Date().toISOString() }, null, 1));
      console.log(`SOLVED in ${Math.round(ms / 1000)} s -> ${file}`);
      console.log(`    submit: to=${CONTRACT} data=minedMint(salt*, ${result.nonce}) value=your deposit (miner-bound; stale-after-any-mint => regrind)`);
    }
    const rate = Math.round(SOLVES * 16777216 / ((Date.now() - t0) / 1000));
    console.log(`done. aggregate rate ~${rate > 1e6 ? (rate / 1e6).toFixed(1) + 'M' : rate} H/s across ${WORKERS} cores.`);
    process.exit(0);
  })().catch(e => { console.error('fail:', e.message); process.exit(1); });
} else if (process.env.WORKER === '1') {
  const target = BigInt(process.env.W_TARGET);
  const salt = process.env.W_SALT, epoch = process.env.W_EPOCH, miner = process.env.W_MINER;
  const N = parseInt(process.env.N, 10), id = process.pid % N;
  const t0 = Date.now();
  for (let n = id; ; n += N) {
    const d = BigInt('0x' + keccak256(preimageHex(salt, n, miner, epoch), 'hex'));
    if (d < target) {
      process.send({ solve: { epoch, salt, nonce: n, t0 } });
      break;
    }
  }
} else { console.error('unknown mode'); process.exit(1); }