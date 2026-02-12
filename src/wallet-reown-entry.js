/**
 * Reown AppKit (wallet connect modal) – bundled entry.
 * Fetches projectId from API, then creates modal and exposes window.openReownConnect.
 */
import { createAppKit } from '@reown/appkit';
import { EthersAdapter } from '@reown/appkit-adapter-ethers';
import { defineChain } from '@reown/appkit/networks';

window.useReownConnect = false;
window.reownReady = false;
window.reownInitFailed = false;
window.openReownConnect = null;

const baseMainnet = defineChain({
  id: 8453,
  caipNetworkId: 'eip155:8453',
  chainNamespace: 'eip155',
  name: 'Base',
  nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
  rpcUrls: { default: { http: ['https://mainnet.base.org'] } },
  blockExplorers: {
    default: { name: 'BaseScan', url: 'https://basescan.org' },
  },
});

async function initReown() {
  try {
    const res = await fetch('/api/betting/contract-info');
    const data = await res.json();
    const projectId = data.reownProjectId;
    if (!projectId || typeof projectId !== 'string') return;

    const metadata = {
      name: 'Claw IO',
      description: 'Bet on AI agents in Claw IO',
      url: typeof window !== 'undefined' ? window.location.origin : '',
      icons: [typeof window !== 'undefined' ? window.location.origin + '/favicon.ico' : ''],
    };

    const modal = createAppKit({
      adapters: [new EthersAdapter()],
        networks: [baseMainnet],
      projectId,
      metadata,
      features: { analytics: false },
    });

    modal.subscribeProvider(function (state) {
      const isConnected = state.isConnected;
      const provider = state.provider;
      const address = state.address;

      window.__reownState = { isConnected, provider, address };

      if (isConnected && provider && address) {
        window.dispatchEvent(new CustomEvent('reown-wallet-connected', { detail: { provider, address } }));
      } else {
        window.dispatchEvent(new CustomEvent('reown-wallet-disconnected'));
      }
    });

    window.openReownConnect = function () {
      modal.open({ view: 'Connect' });
    };

    window.reownModal = modal;
    window.useReownConnect = true;
    window.reownReady = true;
    window.dispatchEvent(new Event('reown-ready'));
  } catch (err) {
    console.warn('[Reown] Init failed, falling back to direct MetaMask:', err);
    window.reownInitFailed = true;
  }
}

initReown();
