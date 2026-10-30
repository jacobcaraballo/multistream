use thiserror::Error;

#[derive(Debug, Error)]
pub enum VodError {
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("Validation error: {0}")]
    Validation(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Restricted: {0}")]
    Restricted(String),

    #[error("API error: {0}")]
    Api(String),
}

impl serde::Serialize for VodError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
