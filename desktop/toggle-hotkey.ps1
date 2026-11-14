# SPDX-License-Identifier: MIT
param([switch]$ValidateOnly)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RainyLyricsToggle {
 [StructLayout(LayoutKind.Sequential)] struct POINT {public int X,Y;}
 [StructLayout(LayoutKind.Sequential)] struct MSG {public IntPtr H;public uint Message;public UIntPtr W;public IntPtr L;public uint Time;public POINT Point;public uint Private;}
 [DllImport("user32.dll",SetLastError=true)] static extern bool RegisterHotKey(IntPtr w,int id,uint mods,uint key);
 [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr w,int id);
 [DllImport("user32.dll")] static extern int GetMessage(out MSG m,IntPtr w,uint a,uint b);
 public static void Run(){
  if(!RegisterHotKey(IntPtr.Zero,24577,0x4002,0x77)){Console.WriteLine("{\"event\":\"error\",\"message\":\"Ctrl+F8 is already registered\"}");Console.Out.Flush();return;}
  try{Console.WriteLine("{\"event\":\"ready\",\"shortcut\":\"Ctrl+F8\"}");Console.Out.Flush();MSG msg;while(GetMessage(out msg,IntPtr.Zero,0,0)>0){if(msg.Message==0x312&&msg.W.ToUInt64()==24577){Console.WriteLine("{\"event\":\"toggle\"}");Console.Out.Flush();}}}
  finally{UnregisterHotKey(IntPtr.Zero,24577);}
 }
}
'@
if($ValidateOnly){'Hotkey helper compiled; no shortcut registered.';exit}
[RainyLyricsToggle]::Run()
