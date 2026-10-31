use std::cell::RefCell;
use std::rc::Rc;
use std::thread::LocalKey;

use tsrs_compiler::Program;

pub type ProgramFactSlot<F> = RefCell<Option<((usize, usize), Rc<F>)>>;

pub trait ProgramFact: Sized + 'static {
    fn slot() -> &'static LocalKey<ProgramFactSlot<Self>>;

    fn build(program: &Program) -> Self;

    fn for_program(program: &Program) -> Rc<Self> {
        let files = program.get_source_files();
        let key = (files.as_ptr().addr(), files.len());
        Self::slot().with(|slot| {
            if let Some((cached_key, fact)) = slot.borrow().as_ref()
                && *cached_key == key
            {
                return Rc::clone(fact);
            }
            let fact = Rc::new(Self::build(program));
            *slot.borrow_mut() = Some((key, Rc::clone(&fact)));
            fact
        })
    }
}
