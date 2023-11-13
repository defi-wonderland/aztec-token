import { TokenContract } from '../artifacts/Token.js';
import { TokenSimulator } from './token_simulator.js';
import {
  AccountWallet,
  AccountWalletWithPrivateKey,
  Fr,
  Note,
  PXE,
  TxHash,
  TxStatus,
  computeAuthWitMessageHash,
  computeMessageSecretHash,
  createAccount,
  createPXEClient,
  getSandboxAccountsWallets,
  waitForSandbox,
} from '@aztec/aztec.js';
import { AztecAddress, CompleteAddress } from '@aztec/circuits.js';
import { DebugLogger, createDebugLogger } from '@aztec/foundation/log';
import { ExtendedNote } from '@aztec/types';
import { afterEach, beforeAll, expect, jest } from '@jest/globals';

// assumes sandbox is running locally, which this script does not trigger
// as well as anvil.  anvil can be started with yarn test:integration
const setupSandbox = async () => {
  const { PXE_URL = 'http://localhost:8080' } = process.env;
  const pxe = createPXEClient(PXE_URL);
  await waitForSandbox(pxe);
  return pxe;
};

const TIMEOUT = 60_000;

describe('e2e_token_contract', () => {
  jest.setTimeout(TIMEOUT);

  let wallets: AccountWalletWithPrivateKey[];
  let logger: DebugLogger;

  let asset: TokenContract;

  let tokenSim: TokenSimulator;
  let pxe: PXE;

  beforeAll(async () => {
    logger = createDebugLogger('box:token_contract_test');
    pxe = await setupSandbox();

    wallets = await getSandboxAccountsWallets(pxe);

    logger(`Wallets: ${wallets.map(w => w.getAddress().toString())}`);

    asset = await TokenContract.deploy(wallets[0], wallets[0].getAddress()).send().deployed();
    logger(`Token deployed to ${asset.address}`);
    tokenSim = new TokenSimulator(
      asset,
      logger,
      wallets.map(a => a.getAddress()),
    );

    expect(await asset.methods.admin().view()).toBe(wallets[0].getAddress().toBigInt());
  }, 100_000);

  afterEach(async () => {
    await tokenSim.check();
  }, TIMEOUT);

  describe('Escrow', () => {
    let amount: bigint;
  
    let participant1: AccountWalletWithPrivateKey;
    let participant2: AccountWalletWithPrivateKey;
    let participant3: AccountWalletWithPrivateKey;
    let agent: AccountWalletWithPrivateKey;
  
    let from: CompleteAddress;
    
    beforeAll(async () => {
      from = wallets[0].getCompleteAddress();
      participant1 = await createAccount(pxe);
      participant2 = await createAccount(pxe);
      participant3 = await createAccount(pxe);
      agent = await createAccount(pxe);

      await mintTokenFor(wallets[0], wallets[0], 10000n);
    });
    
    describe('Escrow flow', () => {
  
      let balance: bigint;
      
      it('escrow', async () => {
        balance = await asset.methods.balance_of_private(from.address).view();
        amount = balance / 2n;
        expect(amount).toBeGreaterThan(0n);
  
        const tx = asset.methods.escrow(from.address, agent.getAddress(), amount, [from.address, participant1.getAddress(), participant2.getAddress(), participant3.getAddress()], 0).send();
        const receipt = await tx.wait();
        expect(receipt.status).toBe(TxStatus.MINED);
        tokenSim.escrow(from.address, amount);
  
        const newBalance = await asset.methods.balance_of_private(from.address).view();
        expect(newBalance).toEqual(balance - amount);
      });
  
      it('settle_escrow', async () => {
        const escrows = await asset.withWallet(wallets[0]).methods.get_escrows(0n).view();

        const escrowNotes = await pxe.getNotes({
          contractAddress: asset.address,
          storageSlot: new Fr(7),
        });
        
        const escrowNotes2 = await pxe.getNotes({
          owner: participant1.getAddress(),
          contractAddress: asset.address,
          storageSlot: new Fr(7),
        });

        console.log(escrowNotes);

        console.log(escrowNotes2);

        console.log(escrows);

        // const randomness = escrowNotes[0].note.items[1];
        // const txClaim = asset.withWallet(agent).methods.settle_escrow(agent.getAddress(), participant1.getAddress(), amount, randomness, 0).send();
        // const receiptClaim = await txClaim.wait();
        // expect(receiptClaim.status).toBe(TxStatus.MINED);
        // tokenSim.settle_escrow(participant1.getAddress(), amount);
  
        const newBalance = await asset.methods.balance_of_private(from.address).view();
        expect(newBalance).toEqual(balance);
      });
    });
  });

  const addPendingShieldNoteToPXE = async (
    account: AccountWalletWithPrivateKey,
    amount: bigint,
    secretHash: Fr,
    txHash: TxHash
  ) => {
    const storageSlot = new Fr(5); // The storage slot of `pending_shields` is 5.
  
    await pxe.addNote(
      new ExtendedNote(
        new Note([new Fr(amount), secretHash]),
        account.getAddress(),
        asset.address,
        storageSlot,
        txHash
      )
    );
  };
  
  const mintTokenFor = async (
    account: AccountWalletWithPrivateKey,
    minter: AccountWalletWithPrivateKey,
    amount: bigint
  ) => {
    // Mint private tokens
    const secret = Fr.random();
    const secretHash = await computeMessageSecretHash(secret);
  
    const receipt = await asset
      .withWallet(minter)
      .methods.mint_private(amount, secretHash)
      .send()
      .wait();

    tokenSim.mintPrivate(amount);
  
    await addPendingShieldNoteToPXE(minter, amount, secretHash, receipt.txHash);
  
    await asset
      .withWallet(minter)
      .methods.redeem_shield(account.getAddress(), amount, secret)
      .send()
      .wait();

    tokenSim.redeemShield(account.getAddress(), amount);
  };
});