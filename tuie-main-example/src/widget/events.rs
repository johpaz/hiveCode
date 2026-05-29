//! Standard widget event payloads dispatched along a [`WidgetPath`](super::WidgetPath).

/// Scroll offset change notification.
pub struct ScrollEvent;

/// Click notification.
pub struct ClickEvent;

/// Value change notification carrying the new value.
pub struct ChangeEvent<T>(pub T);

/// Request from a [`List`](crate::widget::widgets::list::List) for the given index range to be loaded.
pub struct ListRequestEvent(pub std::ops::Range<usize>);
