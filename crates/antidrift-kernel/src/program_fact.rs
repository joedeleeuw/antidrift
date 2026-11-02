use std::cell::RefCell;
use std::rc::Rc;
use std::thread::LocalKey;

use tsrs_compiler::Program;

pub struct ProgramFactCache<F> {
    files_addr: usize,
    files_len: usize,
    first_file_addr: usize,
    cwd: String,
    fact: Rc<F>,
}

pub type ProgramFactSlot<F> = RefCell<Option<ProgramFactCache<F>>>;

pub trait ProgramFact: Sized + 'static {
    fn slot() -> &'static LocalKey<ProgramFactSlot<Self>>;

    fn build(program: &Program) -> Self;

    fn for_program(program: &Program) -> Rc<Self> {
        let files = program.get_source_files();
        let files_addr = files.as_ptr().addr();
        let files_len = files.len();
        let first_file_addr = files.first().map_or(0, |sf| sf.file_name().as_ptr().addr());
        let cwd = program.host().get_current_directory();
        Self::slot().with(|slot| {
            if let Some(cached) = slot.borrow().as_ref()
                && cached.files_addr == files_addr
                && cached.files_len == files_len
                && cached.first_file_addr == first_file_addr
                && cached.cwd == cwd
            {
                return Rc::clone(&cached.fact);
            }
            let fact = Rc::new(Self::build(program));
            *slot.borrow_mut() = Some(ProgramFactCache {
                files_addr,
                files_len,
                first_file_addr,
                cwd: cwd.to_owned(),
                fact: Rc::clone(&fact),
            });
            fact
        })
    }
}
