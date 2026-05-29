pub struct FlatLookup<K, V> {
    entries: Vec<(K, V)>,
}

impl<K: PartialEq, V> FlatLookup<K, V> {
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    pub fn get(&self, key: &K) -> Option<&V> {
        self.entries
            .iter()
            .find(|entry| entry.0 == *key)
            .map(|entry| &entry.1)
    }

    pub fn insert(&mut self, key: K, value: V) -> Option<V> {
        if let Some(entry) = self.entries.iter_mut().find(|entry| entry.0 == key) {
            Some(std::mem::replace(&mut entry.1, value))
        } else {
            self.entries.push((key, value));
            None
        }
    }
}
