use dep::aztec::{
    note::{
        note_header::NoteHeader,
        note_interface::NoteInterface,
        utils::compute_note_hash_for_read_or_nullify,
        note_getter_options::NoteGetterOptions,
    },
    oracle::{
        get_secret_key::get_secret_key,
        get_public_key::get_public_key,
    },
    log::emit_encrypted_log,
    hash::pedersen_hash,
    context::PrivateContext,
    types::{
        type_serialization::{
            aztec_address_serialization::{AztecAddressSerializationMethods, AZTEC_ADDRESS_SERIALIZED_LEN},
        },
        address::{AztecAddress}, 
    },
    state_vars::{set::Set},
};

global ESCROW_NOTE_LEN: Field = 7; // 3 plus 4 participants plus a header.

// docs:start:value-note-def
struct EscrowNote {
    value: Field,
    agent: AztecAddress,
    randomness: Field,
    // Having the participants in the note leaks some privacy as all the participants will know each other.
    // But, it allows us to use the broadcast function correctly and to be able to do partial withdrawals of the escrow.
    participants: [AztecAddress; 4], 
    header: NoteHeader,
}
// docs:end:value-note-def

impl EscrowNote {
    pub fn new(value: Field, agent: AztecAddress, randomness: Field, participants: [AztecAddress; 4]) -> Self {
        let header = NoteHeader::empty();
        EscrowNote {
            value,
            agent,
            randomness,
            participants,
            header,
        }
    }

    pub fn serialize(self) -> [Field; ESCROW_NOTE_LEN] {
        [
            self.value, 
            self.agent.address, 
            self.randomness, 
            self.participants[0].address, 
            self.participants[1].address, 
            self.participants[2].address, 
            self.participants[3].address
        ]
    }

    pub fn deserialize(preimage: [Field; ESCROW_NOTE_LEN]) -> Self {
        EscrowNote {
            value: preimage[0],
            agent: AztecAddress::new(preimage[1]),
            randomness: preimage[2],
            participants: 
                [
                    AztecAddress::new(preimage[3]), 
                    AztecAddress::new(preimage[4]), 
                    AztecAddress::new(preimage[5]), 
                    AztecAddress::new(preimage[6])
                ],
            header: NoteHeader::empty(),
        }
    }

    pub fn compute_note_hash(self) -> Field {
        // TODO(#1205) Should use a non-zero generator index.
        pedersen_hash(self.serialize(),0)
    }

    // docs:start:nullifier

    fn compute_nullifier(self) -> Field {
        let note_hash_for_nullify = compute_note_hash_for_read_or_nullify(EscrowNoteMethods, self);
        let nullifier_key = self.randomness;

        pedersen_hash([
            note_hash_for_nullify,
            nullifier_key,
        ], 0)
    }

    // docs:end:nullifier

    pub fn set_header(&mut self, header: NoteHeader) {
        self.header = header;
    }

    // Broadcasts the note as an encrypted log on L1 to all the participants.
    pub fn broadcast(self, context: &mut PrivateContext, slot: Field) {
        let agent_pub_key = get_public_key(self.agent.address);
        if (agent_pub_key.x + agent_pub_key.y != 0) {
            emit_encrypted_log(
                context,
                (*context).this_address(),
                slot,
                agent_pub_key,
                self.serialize(),
            );
        }

        for i in 0..self.participants.len() {
            if(self.participants[i].address != 0) {
                let encryption_pub_key = get_public_key(self.participants[i].address);
                emit_encrypted_log(
                    context,
                    (*context).this_address(),
                    slot,
                    encryption_pub_key,
                    self.serialize(),
                );
            }
        }
    }
}

fn deserialize(preimage: [Field; ESCROW_NOTE_LEN]) -> EscrowNote {
    EscrowNote::deserialize(preimage)
}

fn serialize(note: EscrowNote) -> [Field; ESCROW_NOTE_LEN] {
    note.serialize()
}

fn compute_note_hash(note: EscrowNote) -> Field {
    note.compute_note_hash()
}

fn compute_nullifier(note: EscrowNote) -> Field {
    note.compute_nullifier()
}

fn get_header(note: EscrowNote) -> NoteHeader {
    note.header
}

fn set_header(note: &mut EscrowNote, header: NoteHeader) {
    note.set_header(header)
}

// Broadcasts the note as an encrypted log on L1.
fn broadcast(context: &mut PrivateContext, slot: Field, note: EscrowNote) {
    note.broadcast(context, slot);
}

global EscrowNoteMethods = NoteInterface {
    deserialize,
    serialize,
    compute_note_hash,
    compute_nullifier,
    get_header,
    set_header,
    broadcast,
};
