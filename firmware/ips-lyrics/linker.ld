/* Verified 1024KB F435; blank start of Bank2. IAP erase ends080C0000;
 * existing settings are080FC000/080FE000/080FF800 and never part of image. */
ENTRY(rainy_hook_start)
PHDRS { code PT_LOAD FLAGS(5); state PT_LOAD FLAGS(6); }
MEMORY {
 CODE(rx) : ORIGIN = 0x08080000, LENGTH = 0x8000
 STATE(rwx) : ORIGIN = 0x2005f000, LENGTH = 0x1000
}
SECTIONS {
 .text : { *(.text*) *(.rodata*) } > CODE :code
 /DISCARD/ : { *(.ARM.exidx*) *(.ARM.extab*) }
 .data : { *(.data*) } > STATE AT>CODE :state
 .bss (NOLOAD) : { __live_bss_start__ = .; *(.bss*) *(COMMON) __live_bss_end__ = .; } > STATE :state
}
ASSERT(SIZEOF(.data)==0,"No startup-copy implementation")
ASSERT(SIZEOF(.bss)<=4096,"Fixed state exceeds known reservation")
ASSERT(SIZEOF(.text)<=32768,"Code exceeds verified blank Bank2 reservation")
