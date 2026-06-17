//! Unit tests for `pallet-microblog` (M0 plain posting).

use crate::{mock::*, ByAuthor, Error, Event, NextPostId, Posts};
use frame_support::{assert_noop, assert_ok};

#[test]
fn post_and_read_works() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(Microblog::post_message(
			RuntimeOrigin::signed(1),
			b"gm cogno".to_vec(),
			None
		));

		assert_eq!(NextPostId::<Test>::get(), 1);
		let post = Posts::<Test>::get(0).expect("post 0 should exist");
		assert_eq!(post.author, 1);
		assert_eq!(post.text.to_vec(), b"gm cogno".to_vec());
		assert_eq!(post.parent, None);
		assert_eq!(ByAuthor::<Test>::get(1).to_vec(), vec![0]);
		System::assert_last_event(Event::PostCreated { id: 0, author: 1 }.into());
	});
}

#[test]
fn replies_carry_parent() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(Microblog::post_message(RuntimeOrigin::signed(1), b"root".to_vec(), None));
		assert_ok!(Microblog::post_message(RuntimeOrigin::signed(2), b"reply".to_vec(), Some(0)));
		assert_eq!(Posts::<Test>::get(1).unwrap().parent, Some(0));
	});
}

#[test]
fn too_long_is_rejected() {
	new_test_ext().execute_with(|| {
		let big = vec![0u8; 513]; // MaxLength = 512
		assert_noop!(
			Microblog::post_message(RuntimeOrigin::signed(1), big, None),
			Error::<Test>::TooLong
		);
		assert_eq!(NextPostId::<Test>::get(), 0);
	});
}

#[test]
fn delete_post_works_and_guards_author() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(Microblog::post_message(RuntimeOrigin::signed(1), b"hello".to_vec(), None));

		// A non-author cannot delete.
		assert_noop!(
			Microblog::delete_post(RuntimeOrigin::signed(2), 0),
			Error::<Test>::NotAuthor
		);
		// Deleting a missing id fails.
		assert_noop!(
			Microblog::delete_post(RuntimeOrigin::signed(1), 99),
			Error::<Test>::NotFound
		);

		// The author can delete; the post and its index entry are removed.
		assert_ok!(Microblog::delete_post(RuntimeOrigin::signed(1), 0));
		assert!(Posts::<Test>::get(0).is_none());
		assert!(ByAuthor::<Test>::get(1).is_empty());
		System::assert_last_event(Event::PostDeleted { id: 0 }.into());
	});
}

#[test]
fn too_many_posts_is_rejected_without_consuming_id() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		// MaxPostsPerAuthor = 8 in the mock.
		for _ in 0..8u64 {
			assert_ok!(Microblog::post_message(RuntimeOrigin::signed(1), vec![b'x'], None));
		}
		assert_eq!(ByAuthor::<Test>::get(1).len(), 8);
		assert_eq!(NextPostId::<Test>::get(), 8);

		// The 9th overflows the author index — rejected, and (assert_noop! proves) no
		// storage changed, so the id counter was not consumed.
		assert_noop!(
			Microblog::post_message(RuntimeOrigin::signed(1), vec![b'y'], None),
			Error::<Test>::TooManyPosts
		);
		assert_eq!(NextPostId::<Test>::get(), 8);

		// A different author is unaffected.
		assert_ok!(Microblog::post_message(RuntimeOrigin::signed(2), vec![b'z'], None));
		assert_eq!(NextPostId::<Test>::get(), 9);
	});
}
