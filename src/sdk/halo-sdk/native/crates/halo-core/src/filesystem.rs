use crate::{
    error::{Error, Result},
    harness::TextId,
};
use tokio::{
    fs::File,
    io::{AsyncReadExt, AsyncSeekExt},
};

pub(crate) async fn read_bounded(file: &mut File, limit: usize) -> Result<Vec<u8>> {
    let metadata = file.metadata().await?;
    if !metadata.is_file() {
        return Err(Error::new("FILE_READ", "").with_harness(TextId::ToolsFileRegularOnly, &[]));
    }
    if metadata.len() > limit as u64 {
        return Err(Error::new("FILE_READ", "").with_harness(
            TextId::ToolsFileReadLimit,
            &[("limit", limit.to_string().into())],
        ));
    }
    let mut bytes = vec![0; (metadata.len() as usize + 1).min(limit + 1)];
    file.seek(std::io::SeekFrom::Start(0))
        .await
        .map_err(Error::from)?;
    let mut offset = 0;
    while offset < bytes.len() {
        let count = file.read(&mut bytes[offset..]).await.map_err(Error::from)?;
        if count == 0 {
            bytes.truncate(offset);
            return Ok(bytes);
        }
        offset += count;
    }
    if offset as u64 > metadata.len() {
        return Err(Error::new("FILE_READ", "").with_harness(TextId::ToolsFileGrew, &[]));
    }
    bytes.truncate(offset);
    Ok(bytes)
}
