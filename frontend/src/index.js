import React from "react";
import ReactDOM from "react-dom/client";
import { createWeb3Modal, defaultConfig } from "@web3modal/ethers/react";
import App from "./App";
import "./index.css";

const projectId = process.env.REACT_APP_WC_PROJECT_ID;

const injectiveTestnet = {
  chainId: 1738,
  name: "Injective Testnet",
  currency: "INJ",
  explorerUrl: "https://testnet.explorer.injective.network",
  rpcUrl:
    process.env.REACT_APP_RPC_URL ||
    "https://inevm-rpc.testnet.injective.network",
};

if (projectId) {
  createWeb3Modal({
    ethersConfig: defaultConfig({
      metadata: {
        name: "InjShield",
        description: "Private payments on Injective",
        url: window.location.origin,
        icons: [],
      },
      enableEIP6963: true,
      enableInjected: true,
      enableCoinbase: false,
      rpcUrl: injectiveTestnet.rpcUrl,
      defaultChainId: 1738,
    }),
    chains: [injectiveTestnet],
    projectId,
    enableAnalytics: false,
    themeMode: "dark",
    themeVariables: {
      "--w3m-color-mix": "#9945ff",
      "--w3m-color-mix-strength": 25,
      "--w3m-accent": "#9945ff",
      "--w3m-border-radius-master": "12px",
      "--w3m-font-family": "-apple-system, BlinkMacSystemFont, sans-serif",
    },
  });
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <App wcEnabled={!!projectId} />
  </React.StrictMode>
);
