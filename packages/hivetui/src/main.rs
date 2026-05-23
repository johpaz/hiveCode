use color_eyre::eyre::Result;

#[tokio::main]
async fn main() -> Result<()> {
    color_eyre::install()?;
    if std::env::var("HIVETUI_HEADLESS").as_deref() == Ok("1") {
        hivetui::app::run_headless().await
    } else {
        hivetui::app::run().await
    }
}
