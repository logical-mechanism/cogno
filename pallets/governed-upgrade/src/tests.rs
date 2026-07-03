//! Unit tests for `pallet-governed-upgrade`: the `AuthorityOrigin` gate, and that a successful
//! `authorize_upgrade` actually records the authorization in `frame_system` (with version-check on).

use crate::{mock::*, Event};
use frame_support::{assert_noop, assert_ok};
use sp_core::H256;
use sp_runtime::traits::BadOrigin;

#[test]
fn authority_origin_can_authorize_upgrade() {
    new_test_ext().execute_with(|| {
        let code_hash = H256::repeat_byte(0xab);
        assert_ok!(GovernedUpgrade::authorize_upgrade(
            RuntimeOrigin::root(),
            code_hash
        ));

        // The pallet-scoped audit marker fired …
        System::assert_has_event(Event::UpgradeAuthorized { code_hash }.into());
        // … and `frame_system` recorded the authorization WITH version-checking on (so a later
        // `apply_authorized_upgrade` will refuse a non-increasing spec_version). This proves the inner
        // `do_authorize_upgrade(code_hash, true)` ran.
        System::assert_has_event(
            frame_system::Event::UpgradeAuthorized {
                code_hash,
                check_version: true,
            }
            .into(),
        );
    });
}

#[test]
fn non_authority_cannot_authorize_upgrade() {
    new_test_ext().execute_with(|| {
        // A plain signed origin is NOT the ≥3/5 committee (here: not root) — rejected, no state change.
        assert_noop!(
            GovernedUpgrade::authorize_upgrade(RuntimeOrigin::signed(1), H256::repeat_byte(0x01)),
            BadOrigin
        );
        assert_noop!(
            GovernedUpgrade::authorize_upgrade(RuntimeOrigin::none(), H256::repeat_byte(0x02)),
            BadOrigin
        );
    });
}
