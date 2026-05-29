//! LIFO pool of reusable scratch buffers.

use std::cell::{Cell, RefCell};

/// Stack-disciplined pool of `T` values accessed through RAII guards.
pub struct StackPool<T> {
    items: RefCell<Vec<T>>,
    depth: Cell<usize>,
}

/// RAII handle to a `T` checked out from a [`StackPool`].
pub struct StackPoolGuard<'a, T> {
    pool: &'a StackPool<T>,
    item: Option<T>,
    depth: usize,
}

impl<T> StackPool<T> {
    /// Creates an empty pool.
    pub const fn new() -> Self {
        Self {
            items: RefCell::new(Vec::new()),
            depth: Cell::new(0),
        }
    }
}

impl<T: Default> StackPool<T> {
    /// Checks out a `T` from the pool, creating one with [`Default`] if the pool is empty.
    ///
    /// # Panics
    ///
    /// The returned guard panics on drop if guards are dropped out of stack order.
    pub fn acquire(&self) -> StackPoolGuard<'_, T> {
        let depth = self.depth.get();
        self.depth.set(depth + 1);
        let item = self.items.borrow_mut().pop().unwrap_or_default();
        StackPoolGuard {
            pool: self,
            item: Some(item),
            depth,
        }
    }
}

impl<T> Default for StackPool<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T> std::ops::Deref for StackPoolGuard<'_, T> {
    type Target = T;
    fn deref(&self) -> &T {
        self.item.as_ref().unwrap()
    }
}

impl<T> std::ops::DerefMut for StackPoolGuard<'_, T> {
    fn deref_mut(&mut self) -> &mut T {
        self.item.as_mut().unwrap()
    }
}

impl<T> Drop for StackPoolGuard<'_, T> {
    fn drop(&mut self) {
        let cur = self.pool.depth.get();
        assert_eq!(
            cur,
            self.depth + 1,
            "StackPoolGuard dropped out of order: depth={} top={}",
            self.depth,
            cur,
        );
        self.pool.depth.set(self.depth);
        self.pool.items.borrow_mut().push(self.item.take().unwrap());
    }
}
