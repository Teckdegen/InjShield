const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Account balance:", hre.ethers.formatEther(balance), "INJ");

  const relayerAddress = process.env.RELAYER_ADDRESS || deployer.address;
  console.log("Relayer address:", relayerAddress);

  const Shielded = await hre.ethers.getContractFactory("Shielded");
  const shielded = await Shielded.deploy(relayerAddress);
  await shielded.waitForDeployment();

  const address = await shielded.getAddress();
  console.log("Shielded contract deployed to:", address);
  console.log("\nAdd this to your .env:");
  console.log(`CONTRACT_ADDRESS=${address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
