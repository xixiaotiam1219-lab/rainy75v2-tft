# SPDX-License-Identifier: MIT
param([string]$DevicePath,[switch]$ValidateOnly)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class RainyHidCaps {
 [StructLayout(LayoutKind.Sequential)] public struct CAPS {
  public ushort Usage, UsagePage, InputReportByteLength, OutputReportByteLength, FeatureReportByteLength;
  [MarshalAs(UnmanagedType.ByValArray, SizeConst=17)] public ushort[] Reserved;
  public ushort NumberLinkCollectionNodes, NumberInputButtonCaps, NumberInputValueCaps, NumberInputDataIndices, NumberOutputButtonCaps, NumberOutputValueCaps, NumberOutputDataIndices, NumberFeatureButtonCaps, NumberFeatureValueCaps, NumberFeatureDataIndices;
 }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string p,uint a,uint s,IntPtr sec,uint c,uint f,IntPtr t);
 [DllImport("hid.dll")] static extern bool HidD_GetPreparsedData(SafeFileHandle h,out IntPtr p);
 [DllImport("hid.dll")] static extern bool HidD_FreePreparsedData(IntPtr p);
 [DllImport("hid.dll")] static extern int HidP_GetCaps(IntPtr p,out CAPS c);
 public static CAPS Read(string path) { using(var h=CreateFile(path,0,3,IntPtr.Zero,3,0,IntPtr.Zero)){if(h.IsInvalid)throw new Exception("Cannot inspect HID interface");IntPtr p;if(!HidD_GetPreparsedData(h,out p))throw new Exception("Missing HID descriptor");try{CAPS c;if(HidP_GetCaps(p,out c)!=0x110000)throw new Exception("Invalid HID descriptor");return c;}finally{HidD_FreePreparsedData(p);}} }
}
'@
if($ValidateOnly){'HID descriptor helper compiled; no device opened';exit}
if(-not $DevicePath){throw 'Missing device path'}
$caps=[RainyHidCaps]::Read($DevicePath)
@{Usage=[int]$caps.Usage;UsagePage=[int]$caps.UsagePage;InputReportByteLength=[int]$caps.InputReportByteLength;OutputReportByteLength=[int]$caps.OutputReportByteLength}|ConvertTo-Json -Compress
