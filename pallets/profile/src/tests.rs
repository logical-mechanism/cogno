//! Unit tests for `pallet-profile`.

use crate::{mock::*, Error, Event, PinnedPost, Profiles};
use frame_support::{assert_noop, assert_ok};

#[test]
fn set_and_read_profile_works() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_ok!(Profile::set_profile(
            RuntimeOrigin::signed(1),
            b"alice".to_vec(),
            b"gm".to_vec(),
            b"ipfs://avatar".to_vec(),
            b"ipfs://banner".to_vec(),
            b"earth".to_vec(),
            b"https://cogno.example".to_vec(),
        ));
        let p = Profiles::<Test>::get(1).expect("profile exists");
        assert_eq!(p.display_name.to_vec(), b"alice".to_vec());
        assert_eq!(p.bio.to_vec(), b"gm".to_vec());
        assert_eq!(p.avatar.to_vec(), b"ipfs://avatar".to_vec());
        assert_eq!(p.banner.to_vec(), b"ipfs://banner".to_vec());
        assert_eq!(p.location.to_vec(), b"earth".to_vec());
        assert_eq!(p.website.to_vec(), b"https://cogno.example".to_vec());
        System::assert_last_event(Event::ProfileSet { who: 1 }.into());
    });
}

#[test]
fn set_profile_overwrites() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_ok!(Profile::set_profile(
            RuntimeOrigin::signed(1),
            b"a".to_vec(),
            b"x".to_vec(),
            b"".to_vec(),
            b"".to_vec(),
            b"".to_vec(),
            b"".to_vec()
        ));
        assert_ok!(Profile::set_profile(
            RuntimeOrigin::signed(1),
            b"b".to_vec(),
            b"y".to_vec(),
            b"".to_vec(),
            b"".to_vec(),
            b"".to_vec(),
            b"".to_vec()
        ));
        let p = Profiles::<Test>::get(1).expect("profile exists");
        assert_eq!(p.display_name.to_vec(), b"b".to_vec());
        assert_eq!(p.bio.to_vec(), b"y".to_vec());
    });
}

#[test]
fn set_profile_requires_identity_gate() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        deny_identity(1);
        assert_noop!(
            Profile::set_profile(
                RuntimeOrigin::signed(1),
                b"a".to_vec(),
                b"".to_vec(),
                b"".to_vec(),
                b"".to_vec(),
                b"".to_vec(),
                b"".to_vec()
            ),
            Error::<Test>::NotAllowed
        );
        assert!(Profiles::<Test>::get(1).is_none());
    });
}

#[test]
fn name_too_long_is_rejected() {
    new_test_ext().execute_with(|| {
        let big = vec![0u8; 65]; // MaxName = 64
        assert_noop!(
            Profile::set_profile(
                RuntimeOrigin::signed(1),
                big,
                b"".to_vec(),
                b"".to_vec(),
                b"".to_vec(),
                b"".to_vec(),
                b"".to_vec()
            ),
            Error::<Test>::NameTooLong
        );
    });
}

#[test]
fn bio_too_long_is_rejected() {
    new_test_ext().execute_with(|| {
        let big = vec![0u8; 257]; // MaxBio = 256
        assert_noop!(
            Profile::set_profile(
                RuntimeOrigin::signed(1),
                b"a".to_vec(),
                big,
                b"".to_vec(),
                b"".to_vec(),
                b"".to_vec(),
                b"".to_vec()
            ),
            Error::<Test>::BioTooLong
        );
    });
}

#[test]
fn avatar_too_long_is_rejected() {
    new_test_ext().execute_with(|| {
        let big = vec![0u8; 129]; // MaxAvatar = 128
        assert_noop!(
            Profile::set_profile(
                RuntimeOrigin::signed(1),
                b"a".to_vec(),
                b"".to_vec(),
                big,
                b"".to_vec(),
                b"".to_vec(),
                b"".to_vec()
            ),
            Error::<Test>::AvatarTooLong
        );
    });
}

#[test]
fn banner_location_website_too_long_are_rejected() {
    new_test_ext().execute_with(|| {
        let big = vec![0u8; 129]; // MaxBanner = 128
        assert_noop!(
            Profile::set_profile(
                RuntimeOrigin::signed(1),
                b"a".to_vec(),
                b"".to_vec(),
                b"".to_vec(),
                big,
                b"".to_vec(),
                b"".to_vec()
            ),
            Error::<Test>::BannerTooLong
        );
        let big = vec![0u8; 65]; // MaxLocation = 64
        assert_noop!(
            Profile::set_profile(
                RuntimeOrigin::signed(1),
                b"a".to_vec(),
                b"".to_vec(),
                b"".to_vec(),
                b"".to_vec(),
                big,
                b"".to_vec()
            ),
            Error::<Test>::LocationTooLong
        );
        let big = vec![0u8; 129]; // MaxWebsite = 128
        assert_noop!(
            Profile::set_profile(
                RuntimeOrigin::signed(1),
                b"a".to_vec(),
                b"".to_vec(),
                b"".to_vec(),
                b"".to_vec(),
                b"".to_vec(),
                big
            ),
            Error::<Test>::WebsiteTooLong
        );
    });
}

#[test]
fn clear_profile_works_and_errors_when_absent() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        // Clearing when there's no profile fails.
        assert_noop!(
            Profile::clear_profile(RuntimeOrigin::signed(1)),
            Error::<Test>::NoProfile
        );
        // Set then clear.
        assert_ok!(Profile::set_profile(
            RuntimeOrigin::signed(1),
            b"a".to_vec(),
            b"".to_vec(),
            b"".to_vec(),
            b"".to_vec(),
            b"".to_vec(),
            b"".to_vec()
        ));
        assert_ok!(Profile::clear_profile(RuntimeOrigin::signed(1)));
        assert!(Profiles::<Test>::get(1).is_none());
        System::assert_last_event(Event::ProfileCleared { who: 1 }.into());
    });
}

#[test]
fn pin_and_unpin_post_works() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_ok!(Profile::pin_post(RuntimeOrigin::signed(1), 42));
        assert_eq!(PinnedPost::<Test>::get(1), Some(42));
        System::assert_last_event(Event::PostPinned { who: 1, id: 42 }.into());
        // Pinning again overwrites.
        assert_ok!(Profile::pin_post(RuntimeOrigin::signed(1), 7));
        assert_eq!(PinnedPost::<Test>::get(1), Some(7));
        // Unpin clears it.
        assert_ok!(Profile::unpin_post(RuntimeOrigin::signed(1)));
        assert!(PinnedPost::<Test>::get(1).is_none());
        System::assert_last_event(Event::PostUnpinned { who: 1 }.into());
    });
}

#[test]
fn pin_post_requires_identity_gate() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        deny_identity(1);
        assert_noop!(
            Profile::pin_post(RuntimeOrigin::signed(1), 42),
            Error::<Test>::NotAllowed
        );
        assert!(PinnedPost::<Test>::get(1).is_none());
    });
}

#[test]
fn unpin_without_a_pin_is_rejected() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_noop!(
            Profile::unpin_post(RuntimeOrigin::signed(1)),
            Error::<Test>::NotPinned
        );
    });
}
