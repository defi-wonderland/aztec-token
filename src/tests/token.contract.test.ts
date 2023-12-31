import {
  AccountWalletWithPrivateKey,
  ContractFunctionInteraction,
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
  initAztecJs,
  waitForSandbox
} from '@aztec/aztec.js';
import { AztecAddress, CompleteAddress } from '@aztec/circuits.js';
import { DebugLogger, createDebugLogger } from '@aztec/foundation/log';
import { ExtendedNote } from '@aztec/types';
import { afterEach, beforeAll, expect, jest } from '@jest/globals';
import { TokenContract } from '../contracts/artifacts/Token.js';
import { TokenSimulator } from './token_simulator.js';

// assumes sandbox is running locally, which this script does not trigger
// as well as anvil.  anvil can be started with yarn test:integration
const setupSandbox = async () => {
  const { PXE_URL = 'http://localhost:8080' } = process.env;
  const pxe = createPXEClient(PXE_URL);
  await waitForSandbox(pxe);
  await initAztecJs();
  return pxe;
};

const TIMEOUT = 100_000;

const ADDRESS_ZERO = AztecAddress.fromBigInt(0n);

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

    console.log(`Wallets: ${wallets.map(w => w.getAddress().toString())}`);

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
      let amount: bigint;
      let randomness: bigint;
      
      it('escrow', async () => {
        balance = await asset.methods.balance_of_private(from.address).view();
        amount = balance / 2n;
        expect(amount).toBeGreaterThan(0n);
  
        const tx = asset.methods.escrow(from.address, agent.getAddress(), amount, 0).send();
        const receipt = await tx.wait();
        expect(receipt.status).toBe(TxStatus.MINED);
        tokenSim.escrow(from.address, amount);
      });
      
      it('takes balance form the user', async () => {
        const newBalance = await asset.methods.balance_of_private(from.address).view();
        expect(newBalance).toEqual(balance - amount);
      });

      it('created the correct notes for the agent', async () => {
        const filter = { contractAddress: asset.address, storageSlot: new Fr(7) };

        // Transform all of the pxe getNotes call into a promise.all statement:
        const escrowsAgent = await pxe.getNotes({owner: agent.getAddress(), ...filter});

        expect(escrowsAgent.length).toBe(1);

        randomness = escrowsAgent[0].note.items[2].toBigInt();
        
        // Amount is correct
        expect(escrowsAgent[0].note.items[0].toBigInt()).toEqual(amount);
        // Agent is correct
        expect(escrowsAgent[0].note.items[1].toBigInt()).toEqual(agent.getAddress().toBigInt());
        // Randomness is not 0
        expect(randomness).not.toEqual(0n); 
      });

      it.skip('creates the correct notes after broadcasting', async () => {
        const filter = { contractAddress: asset.address, storageSlot: new Fr(7) };

        let escrowsParticipant1 = await pxe.getNotes({ owner: participant1.getAddress(), ...filter });

        expect(escrowsParticipant1.length).toBe(0);

        // Now we call broadcast escrow note for participant1
        await asset.withWallet(agent).methods.broadcast_escrow_note_for(
          [ 
            participant1.getAddress(), 
            participant2.getAddress(),
            ADDRESS_ZERO,
            ADDRESS_ZERO
          ],
          randomness
        ).send().wait();

        let newEscrowsParticipant1 = await pxe.getNotes({ owner: participant1.getAddress(), ...filter });

        expect(newEscrowsParticipant1.length).toBe(1);

        // Amount is correct
        expect(newEscrowsParticipant1[0].note.items[0].toBigInt()).toEqual(amount);
        // Agent is correct
        expect(newEscrowsParticipant1[0].note.items[1].toBigInt()).toEqual(agent.getAddress().toBigInt());
        // Randomness is correct
        expect(newEscrowsParticipant1[0].note.items[2].toBigInt()).toEqual(randomness); 

        let newEscrowsParticipant2 = await pxe.getNotes({ owner: participant2.getAddress(), ...filter });

        expect(newEscrowsParticipant2.length).toBe(1);

        // Amount is correct
        expect(newEscrowsParticipant2[0].note.items[0].toBigInt()).toEqual(amount);
        // Agent is correct
        expect(newEscrowsParticipant2[0].note.items[1].toBigInt()).toEqual(agent.getAddress().toBigInt());
        // Randomness is correct
        expect(newEscrowsParticipant2[0].note.items[2].toBigInt()).toEqual(randomness); 
      });
  
      it('settle_escrow', async () => {
        const escrows = await asset.withWallet(wallets[0]).methods.get_escrows(0n).view();
        const participant1Balance = await asset.methods.balance_of_private(participant1.getAddress()).view();

        const randomness = escrows[0]._value.randomness;
        const txClaim = asset.withWallet(agent).methods.settle_escrow(agent.getAddress(), participant1.getAddress(), randomness, 0).send();
        const receipt = await txClaim.wait();
        expect(receipt.status).toBe(TxStatus.MINED);
        tokenSim.settle_escrow(participant1.getAddress(), amount);
  
        const newBalance = await asset.methods.balance_of_private(participant1.getAddress()).view();
        expect(newBalance).toEqual(participant1Balance + amount);
      });

      it('removed the notes', async () => {
        const filter = { contractAddress: asset.address, storageSlot: new Fr(7) };

        // Transform all of the pxe getNotes call into a promise.all statement:
        const [escrowsParticipant1, escrowsAgent] = 
          await Promise.all([
            pxe.getNotes({owner: participant1.getAddress(), ...filter}),
            pxe.getNotes({owner: agent.getAddress(), ...filter}),
          ]);

        expect(escrowsParticipant1.length).toBe(0);
        expect(escrowsAgent.length).toBe(0);
      });
    });

    describe('Pay to a random address', () => {
      let balance: bigint;
      let amount: bigint;
      
      it('escrow', async () => {
        balance = await asset.methods.balance_of_private(from.address).view();
        amount = balance / 2n;
        expect(amount).toBeGreaterThan(0n);
  
        const tx = asset.withWallet(wallets[0]).methods.escrow(from.address, agent.getAddress(), amount, 0).send();
        const receipt = await tx.wait();
        expect(receipt.status).toBe(TxStatus.MINED);
        tokenSim.escrow(from.address, amount);
      });

      it('pay random address', async () => {
        const escrows = await asset.withWallet(agent).methods.get_escrows(0n).view();
        const newUser = await createAccount(pxe);
        const userBalance = await asset.methods.balance_of_private(newUser.getAddress()).view();
        expect(userBalance).toBe(0n);

        const randomness = escrows[0]._value.randomness;
        const txClaim = asset.withWallet(agent).methods.settle_escrow(agent.getAddress(), newUser.getAddress(), randomness, 0).send();
        const receipt = await txClaim.wait();
        expect(receipt.status).toBe(TxStatus.MINED);
        tokenSim.settle_escrow(newUser.getAddress(), amount);
  
        const newBalance = await asset.methods.balance_of_private(newUser.getAddress()).view();
        expect(newBalance).toEqual(userBalance + amount);
      });
    });

    describe('Escrow on behalf of another user', () => {
      let balance: bigint;
      let amount: bigint;
      let newUser: AccountWalletWithPrivateKey;
      
      it('escrow on behalf of another user', async () => {
        balance = await asset.methods.balance_of_private(from.address).view();
        amount = balance / 2n;
        expect(amount).toBeGreaterThan(0n);

        newUser = await createAccount(pxe);
        // From address gives permission to newUser to call escrow on their behalf
        const nonce = Fr.random();
        const action = asset
        .withWallet(newUser)
        .methods.escrow(from.address, agent.getAddress(), amount, nonce);
        await approveAction(action, newUser, wallets[0], nonce);
  
        const tx = action.send();
        const receipt = await tx.wait();
        expect(receipt.status).toBe(TxStatus.MINED);
        tokenSim.escrow(from.address, amount);

        const newBalance = await asset.methods.balance_of_private(from.address).view();
        expect(newBalance).toEqual(balance - amount);
      });

      it('settle_escrow on behalf of another user', async () => {
        const escrows = await asset.withWallet(agent).methods.get_escrows(0n).view();
        const participant1Balance = await asset.methods.balance_of_private(participant1.getAddress()).view();
        const randomness = escrows[0]._value.randomness;

        const nonce = Fr.random();
        const action = asset.withWallet(newUser).methods.settle_escrow(agent.getAddress(), participant1.getAddress(), randomness, nonce);
        await approveAction(action, newUser, agent, nonce);
        
        const tx = action.send();
        const receipt = await tx.wait();
        expect(receipt.status).toBe(TxStatus.MINED);
        tokenSim.settle_escrow(participant1.getAddress(), amount);
  
        const newBalance = await asset.methods.balance_of_private(participant1.getAddress()).view();
        expect(newBalance).toEqual(participant1Balance + amount);
      });
    });

    describe('Failure cases', () => {

      let balance: bigint;

      describe('escrow', () => {
        it('fails when the user does not have enough balance', async () => {
          let newUser = await createAccount(pxe);

          expect(await asset.methods.balance_of_private(newUser.getAddress()).view()).toEqual(0n);

          let escrowTx = asset.withWallet(newUser).methods.escrow(newUser.getAddress(), agent.getAddress(), 1n, 0);
          await expect(escrowTx.simulate()).rejects.toThrowError(`(JSON-RPC PROPAGATED) Assertion failed: Balance too low 'minuend.ge(subtrahend) == true'`);
        })

        it('fails when invalid nonce provided', async () => {
          balance = await asset.methods.balance_of_private(from.address).view();
          let amount = balance / 2n;
          expect(amount).toBeGreaterThan(0n);
    
          const tx = asset.withWallet(participant1).methods.escrow(from.address, agent.getAddress(), amount, 0);
          await expect(tx.simulate()).rejects.toThrowError();
        })
      })

      describe('settle_escrow', () => {
        let balance: bigint;

        it('escrow', async () => {
          balance = await asset.methods.balance_of_private(from.address).view();
          amount = balance / 2n;
          expect(amount).toBeGreaterThan(0n);
    
          const tx = asset.methods.escrow(from.address, agent.getAddress(), amount, 0).send();
          const receipt = await tx.wait();
          expect(receipt.status).toBe(TxStatus.MINED);
          tokenSim.escrow(from.address, amount);
    
          const newBalance = await asset.methods.balance_of_private(from.address).view();
          expect(newBalance).toEqual(balance - amount);
        });
    
        it('reverts when calling from a different address and with invalid nonce', async () => {
          const escrows = await asset.withWallet(wallets[0]).methods.get_escrows(0n).view();
          const randomness = escrows[0]._value.randomness;
          const settleTx = asset.withWallet(wallets[0]).methods.settle_escrow(agent.getAddress(), participant1.getAddress(), randomness, 0);
          await expect(settleTx.simulate()).rejects.toThrowError();
        });

        it('reverts when calling from the correct agent but with an invalid nonce', async () => {
          const escrows = await asset.withWallet(wallets[0]).methods.get_escrows(0n).view();
          const randomness = escrows[0]._value.randomness;
          const settleTx = asset.withWallet(agent).methods.settle_escrow(agent.getAddress(), participant1.getAddress(), randomness, 1n);
          await expect(settleTx.simulate()).rejects.toThrowError('invalid nonce');
        })

        it('reverts if escrow does not exist', async () => {
          const settleTx = asset.withWallet(agent).methods.settle_escrow(agent.getAddress(), participant1.getAddress(), 0n, 0);
          await expect(settleTx.simulate()).rejects.toThrowError('escrow does not exist');
        });
      })
    });
  });

  describe('shield_private', () => {
    let amount: bigint = 1000n;
    let mintAmount: bigint = 10000n;
  
    let user: AccountWalletWithPrivateKey;
    let from: CompleteAddress;

    let userPrivateBalanceBefore: bigint;
    let minterPublicBalanceBefore: bigint;
    
    beforeAll(async () => {
      from = wallets[0].getCompleteAddress();
      user = await createAccount(pxe);

      await mintPublicTokens(wallets[0], wallets[0], mintAmount);

      userPrivateBalanceBefore = await asset.methods.balance_of_private(user.getAddress()).view();
      minterPublicBalanceBefore = await asset.methods.balance_of_public(wallets[0].getAddress()).view();
    });

    it('reverts if not enough balance', async () => {
      const tx = asset.withWallet(wallets[0]).methods.shield_private(from.address, user.getAddress(), minterPublicBalanceBefore + 1n, 0);
      await expect(tx.simulate()).rejects.toThrowError();
    });

    it('tx is mined', async () => {
      const tx = asset.withWallet(wallets[0]).methods.shield_private(from.address, user.getAddress(), amount, 0);
      const receipt = await tx.send().wait();
      expect(receipt.status).toBe(TxStatus.MINED);
      tokenSim.shieldPrivate(from.address, user.getAddress(), amount);
    });

    it('decreases the public balance of the sender', async () => {
      const minterPublicBalanceAfter = await asset.methods.balance_of_public(wallets[0].getAddress()).view();
      expect(minterPublicBalanceAfter).toEqual(minterPublicBalanceBefore - amount);
    });

    it('increases the private balance of the receiver', async () => {
      const userPrivateBalanceAfter = await asset.methods.balance_of_private(user.getAddress()).view();
      expect(userPrivateBalanceAfter).toEqual(userPrivateBalanceBefore + amount);
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

  const mintPublicTokens = async (
    account: AccountWalletWithPrivateKey,
    minter: AccountWalletWithPrivateKey, 
    amount: bigint
  ) => {
    const tx = asset
      .withWallet(minter)
      .methods.mint_public(account.getAddress(), amount)
      .send();
    const receipt = await tx.wait();
    expect(receipt.status).toBe(TxStatus.MINED);
    tokenSim.mintPublic(account.getAddress(), amount);
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

  const approveAction = async (action: ContractFunctionInteraction, sender: AccountWalletWithPrivateKey, approver: AccountWalletWithPrivateKey, nonce: Fr) => {
    const messageHash = await computeAuthWitMessageHash(sender.getAddress(), action.request());
    const witness = await approver.createAuthWitness(messageHash);
    await sender.addAuthWitness(witness);
    return nonce;
  };
});
