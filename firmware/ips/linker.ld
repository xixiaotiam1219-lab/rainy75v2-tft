/* Rainy75 V2 IPS factory 0x0002 only. Appended code: 0x0807EC90..0x08080000.
 * Module state: 0x2005F000..0x20060000, shared with the stock application.
 * The reservation has worked on the tested unit; other revisions are unverified. */
ENTRY(rainy_hook_start)
PHDRS {
 live PT_LOAD FLAGS(5);
 state PT_LOAD FLAGS(6);
}
MEMORY {
 APPEND(rx) : ORIGIN = 0x0807ec90, LENGTH = 0x1370
 STATE(rwx) : ORIGIN = 0x2005f000, LENGTH = 0x1000
}
SECTIONS {
 .text : { *(.text*) *(.rodata*) } > APPEND :live
 /* The injected freestanding C has no exceptions or unwinder. Preserve the
  * stock app's unwind data; omit only unused tables from this new module. */
 /DISCARD/ : { *(.ARM.exidx*) *(.ARM.extab*) }
 .data : { *(.data*) } > STATE AT>APPEND :state
 .bss (NOLOAD) : {
  __live_bss_start__ = .;
  *(.bss*) *(COMMON)
  __live_bss_end__ = .;
 } > STATE :state
}
ASSERT(SIZEOF(.data) == 0, "Initialized writable data needs a startup-copy implementation")
ASSERT(SIZEOF(.bss) <= 4096, "State exceeds the 4096-byte module reservation")
