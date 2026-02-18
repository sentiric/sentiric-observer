// build.rs
fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Proto dosyasını derle
    tonic_build::compile_protos("proto/observer.proto")?;
    Ok(())
}