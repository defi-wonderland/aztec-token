// docs:start:token_all
// docs:start:imports
mod types;

// Minimal token implementation that supports `AuthWit` accounts.
// The auth message follows a similar pattern to the cross-chain message and includes a designated caller.
// The designated caller is ALWAYS used here, and not based on a flag as cross-chain.
// message hash = H([caller, contract, selector, ...args])
// To be read as `caller` calls function at `contract` defined by `selector` with `args`
// Including a nonce in the message hash ensures that the message can only be used once.

contract Token {
    // Libs
    use dep::std::option::Option;

    use dep::safe_math::SafeU120;

    use dep::aztec::{
        note::{
            note_getter_options::NoteGetterOptions,
            note_header::NoteHeader,
            utils as note_utils,
            note_viewer_options::NoteViewerOptions
        },
        context::{PrivateContext, PublicContext, Context},
        hash::{compute_secret_hash},
        state_vars::{map::Map, public_state::PublicState, set::Set},
        types::type_serialization::{
            field_serialization::{FieldSerializationMethods, FIELD_SERIALIZED_LEN},
            bool_serialization::{BoolSerializationMethods, BOOL_SERIALIZED_LEN},
            address_serialization::{AddressSerializationMethods, AZTEC_ADDRESS_SERIALIZED_LEN},
        },
        log::emit_encrypted_log,
        oracle::{
            get_public_key::get_public_key,
            rand::rand
        }
    };

    use dep::aztec::protocol_types::{
        abis::function_selector::FunctionSelector,
        address::AztecAddress,
    };

    // docs:start:import_authwit
    use dep::authwit::{
        auth::{
            assert_current_call_valid_authwit, 
            assert_current_call_valid_authwit_public, 
        },
    };
    // docs:end:import_authwit

    use crate::types::{
        transparent_note::{TransparentNote, TransparentNoteMethods, TRANSPARENT_NOTE_LEN},
        owned_value_note::{OwnedValueNote, OWNED_VALUE_NOTE_LEN, OwnedValueNoteMethods},
        balances_map::{BalancesMap},
        safe_u120_serialization::{SafeU120SerializationMethods, SAFE_U120_SERIALIZED_LEN},
    };
    // docs:end::imports

    // docs:start:storage_struct
    struct Storage {
        // docs:start:storage_admin
        admin: PublicState<AztecAddress, AZTEC_ADDRESS_SERIALIZED_LEN>,
        // docs:end:storage_admin
        // docs:start:storage_minters
        minters: Map<AztecAddress, PublicState<bool, BOOL_SERIALIZED_LEN>>,
        // docs:end:storage_minters
        // docs:start:storage_balances
        balances: BalancesMap,
        // docs:end:storage_balances
        total_supply: PublicState<SafeU120, SAFE_U120_SERIALIZED_LEN>,
        // docs:start:storage_pending_shields
        pending_shields: Set<TransparentNote, TRANSPARENT_NOTE_LEN>,
        // docs:end:storage_pending_shields
        public_balances: Map<AztecAddress, PublicState<SafeU120, SAFE_U120_SERIALIZED_LEN>>,
        escrows: Set<OwnedValueNote, OWNED_VALUE_NOTE_LEN>,
    }
    // docs:end:storage_struct

    // docs:start:storage_init
    impl Storage {
        fn init(context: Context) -> Self {
            Storage {
                // docs:start:storage_admin_init
                admin: PublicState::new(
                    context,
                    1,
                    AddressSerializationMethods,
                ),
                // docs:end:storage_admin_init
                // docs:start:storage_minters_init
                minters: Map::new(
                    context,
                    2,
                    |context, slot| {
                        PublicState::new(
                            context,
                            slot,
                            BoolSerializationMethods,
                        )
                    },
                ),
                // docs:end:storage_minters_init
                balances: BalancesMap::new(context, 3),
                total_supply: PublicState::new(
                    context,
                    4,
                    SafeU120SerializationMethods,
                ),
                // docs:start:storage_pending_shields_init
                pending_shields: Set::new(context, 5, TransparentNoteMethods),
                // docs:end:storage_pending_shields_init
                public_balances: Map::new(
                    context,
                    6,
                    |context, slot| {
                        PublicState::new(
                            context,
                            slot,
                            SafeU120SerializationMethods,
                        )
                    },
                ),
                escrows: Set::new(context, 7, OwnedValueNoteMethods),
            }
        }
    }
    // docs:end:storage_init

    // docs:start:constructor
    #[aztec(private)]
    fn constructor(admin: AztecAddress) {
        let selector = FunctionSelector::from_signature("_initialize((Field))");
        context.call_public_function(context.this_address(), selector, [admin.to_field()]);
    }
    // docs:end:constructor

    // docs:start:set_admin
    #[aztec(public)]
    fn set_admin(
        new_admin: AztecAddress,
    ) {
        assert(storage.admin.read().eq(context.msg_sender()), "caller is not admin");
        // docs:start:write_admin
        storage.admin.write(new_admin);
        // docs:end:write_admin
    }
    // docs:end:set_admin

    // docs:start:set_minter
    #[aztec(public)]
    fn set_minter(
        minter: AztecAddress,
        approve: bool,
    ) {
        // docs:start:read_admin
        assert(storage.admin.read().eq(context.msg_sender()), "caller is not admin");
        // docs:end:read_admin
        // docs:start:write_minter
        storage.minters.at(minter).write(approve);
        // docs:end:write_minter
    }
    // docs:end:set_minter

    // docs:start:mint_public
    #[aztec(public)]
    fn mint_public(
        to: AztecAddress,
        amount: Field,
    ) -> Field {
        // docs:start:read_minter
        assert(storage.minters.at(context.msg_sender()).read(), "caller is not minter");
        // docs:end:read_minter
        let amount = SafeU120::new(amount);
        let new_balance = storage.public_balances.at(to).read().add(amount);
        let supply = storage.total_supply.read().add(amount);

        storage.public_balances.at(to).write(new_balance);
        storage.total_supply.write(supply);
        1
    }
    // docs:end:mint_public

    // docs:start:mint_private
    #[aztec(public)]
    fn mint_private(
        amount: Field,
        secret_hash: Field,
    ) -> Field {
        assert(storage.minters.at(context.msg_sender()).read(), "caller is not minter");
        let pending_shields = storage.pending_shields;
        let mut note = TransparentNote::new(amount, secret_hash);
        let supply = storage.total_supply.read().add(SafeU120::new(amount));

        storage.total_supply.write(supply);
        // docs:start:insert_from_public
        pending_shields.insert_from_public(&mut note);
        // docs:end:insert_from_public
        1
    }
    // docs:end:mint_private

    // docs:start:shield
    #[aztec(public)]
    fn shield(
        from: AztecAddress,
        amount: Field,
        secret_hash: Field,
        nonce: Field,
    ) -> Field {
        if (!from.eq(context.msg_sender())) {
            // The redeem is only spendable once, so we need to ensure that you cannot insert multiple shields from the same message.
            assert_current_call_valid_authwit_public(&mut context, from);
        } else {
            assert(nonce == 0, "invalid nonce");
        }

        let amount = SafeU120::new(amount);
        let from_balance = storage.public_balances.at(from).read().sub(amount);

        let pending_shields = storage.pending_shields;
        let mut note = TransparentNote::new(amount.value as Field, secret_hash);

        storage.public_balances.at(from).write(from_balance);
        pending_shields.insert_from_public(&mut note);
        1
    }
    // docs:end:shield

    // docs:start:transfer_public
    #[aztec(public)]
    fn transfer_public(
        from: AztecAddress,
        to: AztecAddress,
        amount: Field,
        nonce: Field,
    ) -> Field {
        if (from != context.msg_sender()) {
            assert_current_call_valid_authwit_public(&mut context, from);
        } else {
            assert(nonce == 0, "invalid nonce");
        }

        let amount = SafeU120::new(amount);
        let from_balance = storage.public_balances.at(from).read().sub(amount);
        storage.public_balances.at(from).write(from_balance);

        let to_balance = storage.public_balances.at(to).read().add(amount);
        storage.public_balances.at(to).write(to_balance);

        1
    }
    // docs:end:transfer_public

    // docs:start:burn_public
    #[aztec(public)]
    fn burn_public(
        from: AztecAddress,
        amount: Field,
        nonce: Field,
    ) -> Field {
        if (from != context.msg_sender()) {
            assert_current_call_valid_authwit_public(&mut context, from);
        } else {
            assert(nonce == 0, "invalid nonce");
        }

        let amount = SafeU120::new(amount);
        let from_balance = storage.public_balances.at(from).read().sub(amount);
        storage.public_balances.at(from).write(from_balance);

        let new_supply = storage.total_supply.read().sub(amount);
        storage.total_supply.write(new_supply);

        1
    }
    // docs:end:burn_public

    // docs:start:redeem_shield
    #[aztec(private)]
    fn redeem_shield(
        to: AztecAddress,
        amount: Field,
        secret: Field,
    ) -> Field {
        let pending_shields = storage.pending_shields;
        let secret_hash = compute_secret_hash(secret);
        let options = NoteGetterOptions::new().select(0, amount).select(1, secret_hash).set_limit(1);
        let notes = pending_shields.get_notes(options);
        let note = notes[0].unwrap_unchecked();
        pending_shields.remove(note);

        storage.balances.at(to).add(SafeU120::new(amount));

        1
    }
    // docs:end:redeem_shield

    // docs:start:unshield
    #[aztec(private)]
    fn unshield(
        from: AztecAddress,
        to: AztecAddress,
        amount: Field,
        nonce: Field,
    ) -> Field {
        if (from != context.msg_sender()) {
            assert_current_call_valid_authwit(&mut context, from);
        } else {
            assert(nonce == 0, "invalid nonce");
        }

        storage.balances.at(from).sub(SafeU120::new(amount));

        let selector = FunctionSelector::from_signature("_increase_public_balance((Field),Field)");
        let _void = context.call_public_function(context.this_address(), selector, [to.to_field(), amount]);

        1
    }
    // docs:end:unshield

    #[aztec(private)]
    fn shield_private(
        from: AztecAddress,
        to: AztecAddress,
        amount: Field,
        nonce: Field,
    ) -> Field {
        if (from != context.msg_sender()) {
            assert_current_call_valid_authwit(&mut context, from);
        } else {
            assert(nonce == 0, "invalid nonce");
        }

        storage.balances.at(to).add(SafeU120::new(amount));

        let selector = FunctionSelector::from_signature("_reduce_public_balance((Field),Field)");
        let _void = context.call_public_function(context.this_address(), selector, [from.to_field(), amount]);

        1
    }

    // docs:start:transfer
    #[aztec(private)]
    fn transfer(
        from: AztecAddress,
        to: AztecAddress,
        amount: Field,
        nonce: Field,
    ) -> Field {
        if (from != context.msg_sender()) {
            assert_current_call_valid_authwit(&mut context, from);
        } else {
            assert(nonce == 0, "invalid nonce");
        }

        let amount = SafeU120::new(amount);
        storage.balances.at(from).sub(amount);
        storage.balances.at(to).add(amount);

        1
    }
    // docs:end:transfer

    // docs:start:burn
    #[aztec(private)]
    fn burn(
        from: AztecAddress,
        amount: Field,
        nonce: Field,
    ) -> Field {
        if (from != context.msg_sender()) {
            assert_current_call_valid_authwit(&mut context, from);
        } else {
            assert(nonce == 0, "invalid nonce");
        }

        storage.balances.at(from).sub(SafeU120::new(amount));

        let selector = FunctionSelector::from_signature("_reduce_total_supply(Field)");
        let _void = context.call_public_function(context.this_address(), selector, [amount]);

        1
    }
    // docs:end:burn

    #[aztec(private)]
    fn escrow(
        from: AztecAddress,
        owner: AztecAddress,
        amount: Field,
        nonce: Field,
    ) -> Field {
        if (from != context.msg_sender()) {
            assert_current_call_valid_authwit(&mut context, from);
        } else {
            assert(nonce == 0, "invalid nonce");
        }

        // Remove the tokens from the user
        let safe_amount = SafeU120::new(amount);
        storage.balances.at(from).sub(safe_amount);

        // create the EscrowNote
        let mut escrow_note = OwnedValueNote::new(SafeU120::new(amount), owner);
        storage.escrows.insert(&mut escrow_note, true);

        escrow_note.randomness
    }

    #[aztec(private)]
    fn settle_escrow(owner: AztecAddress, recipient: AztecAddress, randomness: Field, nonce: Field) -> Field {
        if (owner != context.msg_sender()) {
            assert_current_call_valid_authwit(&mut context, owner);
        } else {
            assert(nonce == 0, "invalid nonce");
        }

        let escrows = storage.escrows;

        // Filter the note
        let options = NoteGetterOptions::new().select(1, owner.to_field()).select(2, randomness).set_limit(1);
        let notes = escrows.get_notes(options);
        
        if(notes[0].is_some()) {
            let note = notes[0].unwrap_unchecked();

            // Check the msg sender is the owner
            assert(note.owner == owner, "msg sender is not the owner");

            // Nullify the note
            escrows.remove(note); 

            // Pay the recipient
            storage.balances.at(recipient).add(note.amount);
        } else {
            // TODO: is there a way to revert directly?
            assert(false, "escrow does not exist");
        }

        1
    }

    #[aztec(private)]
    fn broadcast_escrow_note_for(
        accounts: [AztecAddress; 4],
        randomness: Field
    ) -> Field {
        let escrows = storage.escrows;

        let options = NoteGetterOptions::new().select(2, randomness).set_limit(1);
        let notes = escrows.get_notes(options);
        
        if(notes[0].is_some()) {
            let note = notes[0].unwrap_unchecked();

            for i in 0..accounts.len() {
                if(accounts[i].to_field() != 0) {
                    let encryption_pub_key = get_public_key(accounts[i]);
                    // Emit encrypted log
                    emit_encrypted_log(
                        &mut context,
                        context.this_address(),
                        7,
                        encryption_pub_key,
                        note.serialize(),
                    );
                }
            }
        } else {
            // TODO: is there a way to revert directly?
            assert(false, "escrow does not exist");
        }

        1
    }

    unconstrained fn get_escrows(offset: u32) -> pub [Option<OwnedValueNote>; 10] {
        // TODO: add pagination
        let options = NoteViewerOptions::new().set_offset(offset);
        storage.escrows.view_notes(options)
    }

    // docs:start:initialize
    #[aztec(public)]
    internal fn _initialize(
        new_admin: AztecAddress,
    ) {
        storage.admin.write(new_admin);
        storage.minters.at(new_admin).write(true);
    }
    // docs:end:initialize

    /// Internal ///

    // docs:start:increase_public_balance
    #[aztec(public)]
    internal fn _increase_public_balance(
        to: AztecAddress,
        amount: Field,
    ) {
        let new_balance = storage.public_balances.at(to).read().add(SafeU120::new(amount));
        storage.public_balances.at(to).write(new_balance);
    }
    // docs:end:increase_public_balance

    // docs:start:reduce_total_supply
    #[aztec(public)]
    internal fn _reduce_total_supply(
        amount: Field,
    ) {
        // Only to be called from burn.
        let new_supply = storage.total_supply.read().sub(SafeU120::new(amount));
        storage.total_supply.write(new_supply);
    }
    // docs:end:reduce_total_supply

    #[aztec(public)]
    internal fn _reduce_public_balance(
        from: AztecAddress,
        amount: Field,
    ) {
        let new_balance = storage.public_balances.at(from).read().sub(SafeU120::new(amount));
        storage.public_balances.at(from).write(new_balance);
    }

    /// Unconstrained ///

    // docs:start:admin
    unconstrained fn admin() -> pub Field {
        storage.admin.read().to_field()
    }
    // docs:end:admin

    // docs:start:is_minter
    unconstrained fn is_minter(
        minter: AztecAddress,
    ) -> pub bool {
        storage.minters.at(minter).read()
    }
    // docs:end:is_minter

    // docs:start:total_supply
    unconstrained fn total_supply() -> pub u120 {
        storage.total_supply.read().value
    }
    // docs:end:total_supply

    // docs:start:balance_of_private
    unconstrained fn balance_of_private(
        owner: AztecAddress,
    ) -> pub u120 {
        storage.balances.at(owner).balance_of().value
    }
    // docs:end:balance_of_private

    // docs:start:balance_of_public
    unconstrained fn balance_of_public(
        owner: AztecAddress,
    ) -> pub u120 {
        storage.public_balances.at(owner).read().value
    }
    // docs:end:balance_of_public

    // Below this point is the stuff of nightmares.
    // This should ideally not be required. What do we do if vastly different types of preimages?

    // docs:start:compute_note_hash_and_nullifier
    // Computes note hash and nullifier.
    // Note 1: Needs to be defined by every contract producing logs.
    // Note 2: Having it in all the contracts gives us the ability to compute the note hash and nullifier differently for different kind of notes.
    unconstrained fn compute_note_hash_and_nullifier(contract_address: AztecAddress, nonce: Field, storage_slot: Field, serialized_note: [Field; OWNED_VALUE_NOTE_LEN]) -> pub [Field; 4] {
        let note_header = NoteHeader::new(contract_address, nonce, storage_slot);
        if (storage_slot == 5) {
            note_utils::compute_note_hash_and_nullifier(TransparentNoteMethods, note_header, serialized_note)
        } else {
            note_utils::compute_note_hash_and_nullifier(OwnedValueNoteMethods, note_header, serialized_note)
        }
    }
    // docs:end:compute_note_hash_and_nullifier
}
// docs:end:token_all