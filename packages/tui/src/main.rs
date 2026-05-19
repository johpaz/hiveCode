use color_eyre::eyre::Result;

mod app;
mod ipc;
mod markdown;
mod screens;
mod widgets;

#[tokio::main]
async fn main() -> Result<()> {
    color_eyre::install()?;

    let args: Vec<String> = std::env::args().collect();
    let screen = args
        .iter()
        .position(|a| a == "--screen")
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
        .unwrap_or("repl");

    app::run(screen).await
}
