import detectEthereumProvider from "@metamask/detect-provider";
import { BrowserStorageService } from "./BrowserStorageService";
/* eslint-disable no-console */
import { ConsoleLogService } from "services/ConsoleLogService";
import { BigNumber, BigNumberish, ethers, Signer } from "ethers";
import { BaseProvider, ExternalProvider, Web3Provider, Network } from "@ethersproject/providers";
import Web3Modal from "web3modal";
import WalletConnectProvider from "@walletconnect/web3-provider";
import Torus from "@toruslabs/torus-embed";
import { EventAggregator } from "aurelia-event-aggregator";
import { autoinject } from "aurelia-framework";
import { formatUnits, getAddress, parseUnits } from "ethers/lib/utils";
import { DisclaimerService } from "services/DisclaimerService";
import { Utils } from "services/utils";

interface IEIP1193 {
  on(eventName: "accountsChanged", handler: (accounts: Array<Address>) => void);
  on(eventName: "chainChanged", handler: (chainId: number) => void);
  on(eventName: "connect", handler: (info: { chainId: number }) => void);
  on(eventName: "disconnect", handler: (error: { code: number; message: string }) => void);
}

export type Address = string;
export type Hash = string;

export interface IBlockInfoNative {
  hash: Hash;
  /**
   * previous block
   */
  parentHash: Hash;
  /**
   *The height(number) of this
   */
  number: number;
  timestamp: number;
  /**
   * The maximum amount of gas that this block was permitted to use. This is a value that can be voted up or voted down by miners and is used to automatically adjust the bandwidth requirements of the network.
   */
  gasLimit: BigNumber;
  /**
   * The total amount of gas used by all transactions in this
   */
  gasUsed: BigNumber
  transactions: Array<Hash>;
}

export interface IBlockInfo extends IBlockInfoNative {
  blockDate: Date;
}

export type AllowedNetworks = "mainnet" | "kovan" | "rinkeby";

export enum Networks {
  Mainnet = "mainnet",
  Rinkeby = "rinkeby",
  Kovan = "kovan",
}

export interface IChainEventInfo {
  chainId: number;
  chainName: AllowedNetworks;
  provider: Web3Provider;
}

@autoinject
export class EthereumService {
  constructor(
    private eventAggregator: EventAggregator,
    private disclaimerService: DisclaimerService,
    private consoleLogService: ConsoleLogService,
    private storageService: BrowserStorageService,
  ) { }

  public static ProviderEndpoints = {
    "mainnet": `https://${process.env.RIVET_ID}.eth.rpc.rivet.cloud/`,
    "rinkeby": `https://${process.env.RIVET_ID}.rinkeby.rpc.rivet.cloud/`,
    "kovan": `https://kovan.infura.io/v3/${process.env.INFURA_ID}`,
  };
  private static providerOptions = {
    torus: {
      package: Torus, // required
      options: {
        network: "",
        // networkParams: {
        //   host: "https://localhost:8545", // optional
        //   chainId: 1337, // optional
        //   networkId: 1337, // optional
        // },
        // config: {
        //   buildEnv: "development", // optional
        // },
      },
    },
    // TODO: test with walletconnect
    walletconnect: {
      package: WalletConnectProvider, // required
      options: {
        rpc: {
          1: EthereumService.ProviderEndpoints[Networks.Mainnet],
          4: EthereumService.ProviderEndpoints[Networks.Rinkeby],
          42: EthereumService.ProviderEndpoints[Networks.Kovan],
        },
      },
    },
  };

  public static targetedNetwork: AllowedNetworks;
  public static targetedChainId: number;

  /**
   * provided by ethers
   */
  public readOnlyProvider: BaseProvider;

  private blockSubscribed: boolean;

  private handleNewBlock = async (blockNumber: number): Promise<void> => {
    const block = await this.getBlock(blockNumber);
    this.lastBlock = block;
    this.eventAggregator.publish("Network.NewBlock", block);
  };

  public initialize(network: AllowedNetworks): void {

    if (!network) {
      throw new Error("Ethereum.initialize: `network` must be specified");
    }

    EthereumService.targetedNetwork = network;
    EthereumService.targetedChainId = this.chainIdByName.get(network);
    EthereumService.providerOptions.torus.options.network = network;

    const readonlyEndPoint = EthereumService.ProviderEndpoints[EthereumService.targetedNetwork];
    if (!readonlyEndPoint) {
      throw new Error(`Please connect to either ${Networks.Mainnet} or ${Networks.Rinkeby}`);
    }

    // comment out to run DISCONNECTED
    this.readOnlyProvider = ethers.getDefaultProvider(EthereumService.ProviderEndpoints[EthereumService.targetedNetwork]);
    this.readOnlyProvider.pollingInterval = 15000;

    if (!this.blockSubscribed) {
      this.readOnlyProvider.on("block", (blockNumber: number) => this.handleNewBlock(blockNumber));
      this.blockSubscribed = true;
    }
  }

  private web3Modal: Web3Modal;
  /**
   * provided by Web3Modal
   */
  private web3ModalProvider: Web3Provider & IEIP1193 & ExternalProvider;

  private chainNameById = new Map<number, AllowedNetworks>([
    [1, Networks.Mainnet],
    [4, Networks.Rinkeby],
    [42, Networks.Kovan],
  ]);

  private chainIdByName = new Map<AllowedNetworks, number>([
    [Networks.Mainnet, 1],
    [Networks.Rinkeby, 4],
    [Networks.Kovan, 42],
  ]);

  private async getCurrentAccountFromProvider(provider: Web3Provider): Promise<Signer | string> {
    let account: Signer | string;
    if (Signer.isSigner(provider)) {
      account = provider;
    } else {
      const accounts = await provider.listAccounts();

      if (accounts) {
        account = getAddress(accounts[0]);
      } else {
        account = null;
      }
    }
    return account;
  }

  private async fireAccountsChangedHandler(account: Address) {
    if (account && !(await this.disclaimerService.ensurePrimeDisclaimed(account))) {
      this.disconnect({ code: -1, message: "User declined the Prime Deals disclaimer" });
      account = null;
    }
    console.info(`account changed: ${account}`);
    this.eventAggregator.publish("Network.Changed.Account", account);
  }
  private fireChainChangedHandler(info: IChainEventInfo) {
    console.info(`chain changed: ${info.chainId}`);
    this.eventAggregator.publish("Network.Changed.Id", info);
  }
  private fireConnectHandler(info: IChainEventInfo) {
    console.info(`connected: ${info.chainName}`);
    this.eventAggregator.publish("Network.Changed.Connected", info);
  }
  private fireDisconnectHandler(error: { code: number; message: string }) {
    console.info(`disconnected: ${error?.code}: ${error?.message}`);
    this.eventAggregator.publish("Network.Changed.Disconnect", error);
  }

  /**
   * address, even if signer
   */
  private async getDefaultAccountAddress(): Promise<Address | undefined> {
    if (Signer.isSigner(this.defaultAccount)) {
      return await this.defaultAccount.getAddress();
    } else {
      return getAddress(this.defaultAccount);
    }
  }

  /**
   * signer or address
   */
  private defaultAccount: Signer | Address;

  public getDefaultSigner(): Signer {
    return this.walletProvider.getSigner(this.defaultAccountAddress);
  }

  /**
   * provided by ethers given provider from Web3Modal
   */
  public walletProvider: Web3Provider;
  public defaultAccountAddress: Address;

  private async connect(): Promise<void> {
    if (!this.walletProvider) {
      this.ensureWeb3Modal();
      const web3ModalProvider = await this.web3Modal.connect();
      this.setProvider(web3ModalProvider);
    }
  }

  public ensureConnected(): boolean {
    if (!this.defaultAccountAddress) {
      // TODO: make this await until we're either connected or not?
      this.connect();
      return false;
    }
    else {
      return true;
    }
  }

  /**
   * silently connect to metamask if a metamask account is already connected,
   * without invoking Web3Modal nor MetaMask popups.
   */
  public async connectToConnectedProvider(): Promise<void> {
    // const cachedProvider = this.cachedProvider;
    // const cachedAccount = this.cachedWalletAccount;

    this.ensureWeb3Modal();

    const provider = detectEthereumProvider ? (await detectEthereumProvider({ mustBeMetaMask: true })) as any : undefined;

    /**
     * at this writing, `_metamask.isUnlocked` is "experimental", according to MetaMask.
     * It tells us that the user has logged into Metamask.
     * However, it doesn't tell us whether an account is connected to this dApp.
     * but it sure helps us know whether we can connect without MetaMask asking the user to log in.
     */
    if (provider && provider._metamask.isUnlocked && (await provider._metamask.isUnlocked())) {
      const chainId = this.chainNameById.get(Number(await provider.request({ method: "eth_chainId" })));
      if (chainId === EthereumService.targetedNetwork) {
        const accounts = await provider.request({ method: "eth_accounts" });
        if (accounts?.length) {
          const account = getAddress(accounts[0]);
          if (this.disclaimerService.getPrimeDisclaimed(account)) {
            this.consoleLogService.logMessage(`autoconnecting to ${account}`, "info");
            this.setProvider(provider);
          }
        }
      }
    }
  }

  private ensureWeb3Modal(): void {
    if (!this.web3Modal) {
      this.web3Modal = new Web3Modal({
        // network: Networks.Mainnet,
        cacheProvider: false,
        providerOptions: EthereumService.providerOptions, // required
        theme: "dark",
      });
      /**
       * If a provider has been cached before, and is still set, Web3Modal will use it even
       * if we have pass `cachedProvider: false` above. `cachedProvider: true` only controls
       * whether the provider should be cached, not whether it should be used.
       * So call clearCachedProvider() here to clear it, just in case it has ever been set.
       */
      this.web3Modal?.clearCachedProvider();
    }
  }

  private async getNetwork(provider: Web3Provider): Promise<Network> {
    let network = await provider.getNetwork();
    network = Object.assign({}, network);
    if (network.name === "homestead") {
      network.name = "mainnet";
    }
    return network;
  }

  private async setProvider(web3ModalProvider: Web3Provider & IEIP1193 & ExternalProvider): Promise<void> {
    try {
      if (web3ModalProvider) {
        const walletProvider = new ethers.providers.Web3Provider(web3ModalProvider as any);
        (walletProvider as any).provider.autoRefreshOnNetworkChange = false; // mainly for metamask
        const network = await this.getNetwork(walletProvider);
        if (network.name !== EthereumService.targetedNetwork) {
          this.eventAggregator.publish("Network.wrongNetwork", { provider: web3ModalProvider, connectedTo: network.name, need: EthereumService.targetedNetwork });
          return;
        }
        /**
           * we will keep the original readonly provider which should still be fine since
           * the targeted network cannot have changed.
           */
        this.walletProvider = walletProvider;
        this.web3ModalProvider = web3ModalProvider;
        this.defaultAccount = await this.getCurrentAccountFromProvider(this.walletProvider);
        this.defaultAccountAddress = await this.getDefaultAccountAddress();
        /**
           * because the events aren't fired on first connection
           */
        this.fireConnectHandler({ chainId: network.chainId, chainName: network.name, provider: this.walletProvider });
        this.fireAccountsChangedHandler(this.defaultAccountAddress);

        this.web3ModalProvider.on("accountsChanged", this.handleAccountsChanged);

        this.web3ModalProvider.on("chainChanged", this.handleChainChanged);

        this.web3ModalProvider.on("disconnect", this.handleDisconnect);

        // this.cachedProvider = this.walletProvider;
        // this.cachedWalletAccount = this.defaultAccountAddress;
      }
    } catch (error) {
      this.consoleLogService.logMessage(`Error connecting to wallet provider ${error?.message}`, "error");
      // this.cachedProvider = null;
      // this.cachedWalletAccount = null;
      // this.web3Modal?.clearCachedProvider();
    }
  }

  // private cachedProviderKey = "cachedWalletProvider";
  // private cachedWalletAccountKey = "cachedWalletAccount";

  // private get cachedProvider(): any {
  //   return JSON.parse(this.storageService.lsGet(this.cachedProviderKey));
  // }

  // private set cachedProvider(provider: any) {
  //   if (provider) {
  //     this.storageService.lsSet(this.cachedProviderKey, JSON.stringify(provider));
  //   } else {
  //     this.storageService.lsRemove(this.cachedProviderKey);
  //   }
  // }

  // private get cachedWalletAccount(): Address {
  //   return this.storageService.lsGet(this.cachedWalletAccountKey);
  // }

  // private set cachedWalletAccount(account: Address) {
  //   if (account) {
  //     this.storageService.lsSet(this.cachedWalletAccountKey, account);
  //   } else {
  //     this.storageService.lsRemove(this.cachedWalletAccountKey);
  //   }
  // }

  private handleAccountsChanged = async (accounts: Array<Address>) => {
    this.defaultAccount = await this.getCurrentAccountFromProvider(this.walletProvider);
    this.defaultAccountAddress = await this.getDefaultAccountAddress();
    this.fireAccountsChangedHandler(accounts?.[0]);
  };

  private handleChainChanged = async (chainId: number) => {
    const network = ethers.providers.getNetwork(Number(chainId));

    if (network.name !== EthereumService.targetedNetwork) {
      this.eventAggregator.publish("Network.wrongNetwork", { provider: this.web3ModalProvider, connectedTo: network.name, need: EthereumService.targetedNetwork });
      return;
    }
    else {
      this.fireChainChangedHandler({ chainId: network.chainId, chainName: network.name, provider: this.walletProvider });
    }
  };

  private handleDisconnect = (error: { code: number; message: string }) => {
    this.disconnect(error);
  };

  public disconnect(error: { code: number; message: string }): void {
    // this.cachedProvider = null;
    // this.cachedWalletAccount = null;
    // this.web3Modal?.clearCachedProvider(); // so web3Modal will let the user reconnect
    this.web3ModalProvider?.removeListener("accountsChanged", this.handleAccountsChanged);
    this.web3ModalProvider?.removeListener("chainChanged", this.handleChainChanged);
    this.web3ModalProvider?.removeListener("disconnect", this.handleDisconnect);
    this.defaultAccount = undefined;
    this.defaultAccountAddress = undefined;
    this.fireAccountsChangedHandler(null);
    this.web3ModalProvider = undefined;
    this.walletProvider = undefined;
    this.fireDisconnectHandler(error);
  }

  /**
   *
   * @param provider should be a Web3Provider
   * @returns
   */
  public async switchToTargetedNetwork(provider: ExternalProvider): Promise<boolean> {
    const hexChainId = `0x${EthereumService.targetedChainId.toString(16)}`;
    try {
      if (provider.request) {
        /**
         * note this will simply throw an exception when the website is running on localhost
         */
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: hexChainId }],
        });
        this.setProvider(provider as any);
        return true;
      }
    } catch (err) {
      // user rejected request
      if (err.code === 4001) {
        // return false;
      }
      // chain does not exist, let's add it (see balancer)
      // if (err.code === 4902) {
      //   return importNetworkDetailsToWallet(provider);
      // }
    }
    return false;
  }

  public async addTokenToMetamask(
    tokenAddress: Address,
    tokenSymbol: string,
    tokenDecimals: number,
    tokenImage: string,
  ): Promise<boolean> {

    let wasAdded = false;

    if (this.walletProvider) {

      if (this.getMetamaskHasToken(tokenAddress)) {
        return true;
      }

      try {
      // wasAdded is a boolean. Like any RPC method, an error may be thrown.
        wasAdded = await (this.web3ModalProvider as any).request({
          method: "wallet_watchAsset",
          params: {
            type: "ERC20", // Initially only supports ERC20, but eventually more!
            options: {
              address: tokenAddress, // The address that the token is at.
              symbol: tokenSymbol, // A ticker symbol or shorthand, up to 5 chars.
              decimals: tokenDecimals, // The number of decimals in the token
              image: tokenImage, // A string url of the token logo
            },
          },
        });

        if (wasAdded) {
          this.setMetamaskHasToken(tokenAddress);
        }
      } catch (error) {
        console.log(error);
      }
    }

    return wasAdded;
  }

  public getMetamaskHasToken(tokenAddress: Address): boolean {
    if (!this.defaultAccountAddress) {
      throw new Error("metamaskHasToken: no account");
    }
    return !!this.storageService.lsGet(this.getKeyForMetamaskHasToken(tokenAddress));
  }

  private getKeyForMetamaskHasToken(tokenAddress: Address): string {
    return `${this.defaultAccountAddress}_${tokenAddress}`;
  }

  private setMetamaskHasToken(tokenAddress: Address): void {
    if (!this.defaultAccountAddress) {
      throw new Error("metamaskHasToken: no account");
    }
    this.storageService.lsSet(this.getKeyForMetamaskHasToken(tokenAddress), true);
  }

  public lastBlock: IBlockInfo;

  /**
   * so unit tests will be able to complete
   */
  public dispose(): void {
    this.readOnlyProvider.off("block", (blockNumber: number) => this.handleNewBlock(blockNumber));
  }

  private async getBlock(blockNumber: number): Promise<IBlockInfo> {
    const block = await this.readOnlyProvider.getBlock(blockNumber) as unknown as IBlockInfo;
    block.blockDate = new Date(block.timestamp * 1000);
    return block;
  }

  public getEtherscanLink(addressOrHash: Address | Hash, tx = false): string {
    let targetedNetwork = EthereumService.targetedNetwork as string;
    if (targetedNetwork === Networks.Mainnet) {
      targetedNetwork = "";
    } else {
      targetedNetwork = targetedNetwork + ".";
    }

    return `http://${targetedNetwork}etherscan.io/${tx ? "tx" : "address"}/${addressOrHash}`;
  }
}

/**
 * @param ethValue
 * @param decimals Default is 18.  Can be decimal count or:
 *  "wei",
 *  "kwei",
 *  "mwei",
 *  "gwei",
 *  "szabo",
 *  "finney",
 *  "ether",
 * @returns
 */
export const toWei = (ethValue: BigNumberish, decimals: string | number = 18): BigNumber => {
  const t = typeof ethValue;
  if (t === "string" || t === "number") {
    // avoid underflows
    ethValue = Utils.truncateDecimals(Number(ethValue), Number(decimals));
  }
  return parseUnits(ethValue.toString(), decimals);
};

/**
 * @param weiValue
 * @param decimals Default is 18.  Can be decimal count or:
 *  "wei",
 *  "kwei",
 *  "mwei",
 *  "gwei",
 *  "szabo",
 *  "finney",
 *  "ether",
 * @returns
 */
export const fromWei = (weiValue: BigNumberish, decimals: string | number = 18): string => {
  return formatUnits(weiValue.toString(), decimals);
};

export const NULL_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";
