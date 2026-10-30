use std::hash::{BuildHasher, RandomState};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::headless::{HeadlessRequest, Leftovers, RelayReply};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const REQUEST_READ_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_FRAME_BYTES: u32 = 512 << 20;
const SERVED_KIND: u8 = 0;
const FAILURE_KIND: u8 = 1;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Handshake {
    version: String,
    token: String,
}

fn write_frame(stream: &mut TcpStream, bytes: &[u8]) -> std::io::Result<()> {
    let length = u32::try_from(bytes.len()).map_err(std::io::Error::other)?;
    if length > MAX_FRAME_BYTES {
        return Err(std::io::Error::other(format!(
            "a {length} byte frame exceeds the {MAX_FRAME_BYTES} byte relay limit"
        )));
    }
    stream.write_all(&length.to_le_bytes())?;
    stream.write_all(bytes)
}

fn read_frame(stream: &mut TcpStream) -> std::io::Result<Vec<u8>> {
    let mut length = [0_u8; 4];
    stream.read_exact(&mut length)?;
    let length = u32::from_le_bytes(length);
    if length > MAX_FRAME_BYTES {
        return Err(std::io::Error::other(format!(
            "a {length} byte frame exceeds the {MAX_FRAME_BYTES} byte relay limit"
        )));
    }
    let mut bytes = vec![0_u8; usize::try_from(length).map_err(std::io::Error::other)?];
    stream.read_exact(&mut bytes)?;
    Ok(bytes)
}

fn fresh_token() -> String {
    let state = RandomState::new();
    format!("{:016x}{:016x}", state.hash_one(0_u8), state.hash_one(1_u8))
}

fn read_request(stream: &mut TcpStream, token: &str) -> Result<HeadlessRequest, String> {
    stream
        .set_read_timeout(Some(REQUEST_READ_TIMEOUT))
        .map_err(|err| format!("could not bound the request read: {err}"))?;
    let handshake: Handshake = serde_json::from_slice(
        &read_frame(stream).map_err(|err| format!("could not read the handshake: {err}"))?,
    )
    .map_err(|err| format!("could not decode the handshake: {err}"))?;
    if handshake.token != token {
        return Err("the request carried the wrong token".to_owned());
    }
    if handshake.version != VERSION {
        return Err(format!(
            "antidrift-linter {} cannot relay to the antidrift engine {VERSION}",
            handshake.version
        ));
    }
    serde_json::from_slice(
        &read_frame(stream).map_err(|err| format!("could not read the request: {err}"))?,
    )
    .map_err(|err| format!("could not decode the request: {err}"))
}

fn write_reply(stream: &mut TcpStream, reply: &RelayReply) -> std::io::Result<()> {
    match reply {
        RelayReply::Served { output, leftovers } => {
            stream.write_all(&[SERVED_KIND])?;
            write_frame(stream, output)?;
            write_frame(stream, &serde_json::to_vec(leftovers)?)?;
        }
        RelayReply::Failure(message) => {
            stream.write_all(&[FAILURE_KIND])?;
            write_frame(stream, message.as_bytes())?;
        }
    }
    stream.flush()
}

pub(crate) fn listen<H>(handler: H) -> Result<String, String>
where
    H: Fn(HeadlessRequest) -> RelayReply + Send + 'static,
{
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|err| format!("failed to open the antidrift engine relay on 127.0.0.1: {err}"))?;
    let address = listener
        .local_addr()
        .map_err(|err| format!("failed to read the antidrift engine relay address: {err}"))?;
    let token = fresh_token();
    let endpoint = format!("{address}/{token}");
    std::thread::Builder::new()
        .name("antidrift-relay".to_owned())
        .spawn(move || {
            for accepted in listener.incoming() {
                let mut stream = match accepted {
                    Ok(stream) => stream,
                    Err(err) => {
                        eprintln!(
                            "antidrift engine relay {address} could not accept a request: {err}"
                        );
                        continue;
                    }
                };
                let reply = read_request(&mut stream, &token).map_or_else(
                    |err| {
                        RelayReply::Failure(format!(
                            "the antidrift engine relay refused a request: {err}"
                        ))
                    },
                    &handler,
                );
                if let Err(err) = write_reply(&mut stream, &reply) {
                    eprintln!("antidrift engine relay could not answer {address}: {err}");
                }
            }
        })
        .map_err(|err| format!("failed to start the antidrift engine relay thread: {err}"))?;
    Ok(endpoint)
}

pub(crate) fn relay(endpoint: &str, request: &HeadlessRequest) -> Result<RelayReply, String> {
    let (address, token) = endpoint
        .split_once('/')
        .ok_or_else(|| "expected ADDRESS/TOKEN".to_owned())?;
    let mut stream =
        TcpStream::connect(address).map_err(|err| format!("could not connect: {err}"))?;
    let handshake = Handshake {
        version: VERSION.to_owned(),
        token: token.to_owned(),
    };
    let encoded_handshake = serde_json::to_vec(&handshake)
        .map_err(|err| format!("could not encode the handshake: {err}"))?;
    let encoded_request = serde_json::to_vec(request)
        .map_err(|err| format!("could not encode the request: {err}"))?;
    write_frame(&mut stream, &encoded_handshake)
        .and_then(|()| write_frame(&mut stream, &encoded_request))
        .map_err(|err| format!("could not send the request: {err}"))?;
    let mut kind = [0_u8; 1];
    stream
        .read_exact(&mut kind)
        .map_err(|err| format!("could not read the reply: {err}"))?;
    let first =
        read_frame(&mut stream).map_err(|err| format!("could not read the reply: {err}"))?;
    match kind {
        [SERVED_KIND] => {
            let leftovers: Leftovers = serde_json::from_slice(
                &read_frame(&mut stream)
                    .map_err(|err| format!("could not read the leftovers: {err}"))?,
            )
            .map_err(|err| format!("could not decode the leftovers: {err}"))?;
            Ok(RelayReply::Served {
                output: first,
                leftovers,
            })
        }
        [FAILURE_KIND] => Ok(RelayReply::Failure(
            String::from_utf8_lossy(&first).into_owned(),
        )),
        [other] => Err(format!("the reply has unknown kind {other}")),
    }
}
