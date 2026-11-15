# SPDX-License-Identifier: MIT
param([string]$Source,[string]$Title,[string]$Artist,[string]$Album,[switch]$Watch)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing
$null=[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
$null=[Windows.Storage.Streams.IRandomAccessStreamWithContentType,Windows.Storage.Streams,ContentType=WindowsRuntime]
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.IO;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class RainyAlbumCover {
 [DllImport("shcore.dll", PreserveSig=false)] static extern void CreateStreamOverRandomAccessStream(IntPtr source,ref Guid iid,[MarshalAs(UnmanagedType.Interface)]out IStream stream);
 public static byte[] Read(object random) {
  IntPtr unknown=Marshal.GetIUnknownForObject(random),input=IntPtr.Zero,read=Marshal.AllocHGlobal(4);IStream stream=null;
  try {
   Guid randomId=new Guid("905a0fe1-bc53-11df-8c49-001e4fc686da"),streamId=new Guid("0000000c-0000-0000-c000-000000000046");
   Marshal.ThrowExceptionForHR(Marshal.QueryInterface(unknown,ref randomId,out input));CreateStreamOverRandomAccessStream(input,ref streamId,out stream);
   using(var output=new MemoryStream()) {byte[] chunk=new byte[8192];while(true){stream.Read(chunk,chunk.Length,read);int n=Marshal.ReadInt32(read);if(n<=0)break;if(n>chunk.Length||output.Length+n>2097152)throw new IOException("Cover too large");output.Write(chunk,0,n);}return output.ToArray();}
  } finally {if(stream!=null)Marshal.ReleaseComObject(stream);if(input!=IntPtr.Zero)Marshal.Release(input);Marshal.Release(unknown);Marshal.FreeHGlobal(read);}
 }
 public static byte[] Pixels(object random) {
  using(var data=new MemoryStream(Read(random))) using(var image=Image.FromStream(data)) {
   if(image.Width<1||image.Height<1||(long)image.Width*image.Height>16777216)throw new IOException("Cover dimensions too large");
   using(var bitmap=new Bitmap(64,64)) {
    using(var g=Graphics.FromImage(bitmap)){g.Clear(Color.Black);g.InterpolationMode=InterpolationMode.HighQualityBicubic;g.PixelOffsetMode=PixelOffsetMode.HighQuality;int size=Math.Min(image.Width,image.Height);g.DrawImage(image,new Rectangle(0,0,64,64),new Rectangle((image.Width-size)/2,(image.Height-size)/2,size,size),GraphicsUnit.Pixel);}
    byte[] pixels=new byte[8192];for(int y=0;y<64;y++)for(int x=0;x<64;x++){Color c=bitmap.GetPixel(x,y);int v=(c.R>>3)<<11|(c.G>>2)<<5|(c.B>>3),at=(y*64+x)*2;pixels[at]=(byte)v;pixels[at+1]=(byte)(v>>8);}return pixels;
   }
  }
 }
}
'@
$asTask=[System.WindowsRuntimeSystemExtensions].GetMethods()|Where-Object {$_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'}|Select-Object -First 1
function Await($op,$type){$task=$asTask.MakeGenericMethod($type).Invoke($null,@($op));if(-not $task.Wait(4000)){throw 'Cover request timed out'};return ,$task.Result}
$manager=Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
function Read-Cover([string]$Source,[string]$Title,[string]$Artist,[string]$Album){try {
 foreach($session in $manager.GetSessions()){
  if($session.SourceAppUserModelId -cne $Source){continue}
  $p=Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  if($p.Title -cne $Title -or $p.Artist -cne $Artist -or ($Album -and $p.AlbumTitle -cne $Album) -or -not $p.Thumbnail){continue}
  $raw=Await ($p.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
  $pixels=[RainyAlbumCover]::Pixels($raw)
  [Console]::WriteLine((ConvertTo-Json -Compress @{version=1;rgb565=[Convert]::ToBase64String($pixels)}));return
 }
 [Console]::WriteLine('{"available":false}')
}catch{[Console]::WriteLine('{"available":false,"error":"封面暂不可用"}')}}
if($Watch){while($null -ne ($line=[Console]::ReadLine())){try{$query=ConvertFrom-Json $line;Read-Cover $query.source $query.title $query.artist $query.albumTitle}catch{[Console]::WriteLine('{"available":false}')}[Console]::Out.Flush()}}
else{Read-Cover $Source $Title $Artist $Album}
