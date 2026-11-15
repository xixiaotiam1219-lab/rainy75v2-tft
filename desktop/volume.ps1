# SPDX-License-Identifier: MIT
param([switch]$Watch,[int]$ExitAfterMs=0)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
[ComImport,Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class VolumeDeviceEnumerator {}
[ComImport,Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IVolumeDeviceEnumerator {
 [PreserveSig]int EnumAudioEndpoints(int flow,uint mask,out IntPtr devices);
 [PreserveSig]int GetDefaultAudioEndpoint(int flow,int role,out IVolumeDevice device);
 [PreserveSig]int GetDevice([MarshalAs(UnmanagedType.LPWStr)]string id,out IVolumeDevice device);
 [PreserveSig]int RegisterEndpointNotificationCallback(IVolumeDeviceNotify callback);
 [PreserveSig]int UnregisterEndpointNotificationCallback(IVolumeDeviceNotify callback);
}
[ComImport,Guid("D666063F-1587-4E43-81F1-B948E807363F"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IVolumeDevice {
 [PreserveSig]int Activate(ref Guid iid,uint context,IntPtr parameters,[MarshalAs(UnmanagedType.IUnknown)]out object result);
 [PreserveSig]int OpenPropertyStore(uint access,out IntPtr store);
 [PreserveSig]int GetId([MarshalAs(UnmanagedType.LPWStr)]out string id);
 [PreserveSig]int GetState(out uint state);
}
[ComImport,Guid("5CDF2C82-841E-4546-9722-0CF74078229A"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IVolumeEndpoint {
 [PreserveSig]int RegisterControlChangeNotify(IVolumeCallback callback);
 [PreserveSig]int UnregisterControlChangeNotify(IVolumeCallback callback);
 [PreserveSig]int GetChannelCount(out uint count);
 [PreserveSig]int SetMasterVolumeLevel(float value,ref Guid context);
 [PreserveSig]int SetMasterVolumeLevelScalar(float value,ref Guid context);
 [PreserveSig]int GetMasterVolumeLevel(out float value);
 [PreserveSig]int GetMasterVolumeLevelScalar(out float value);
 [PreserveSig]int SetChannelVolumeLevel(uint channel,float value,ref Guid context);
 [PreserveSig]int SetChannelVolumeLevelScalar(uint channel,float value,ref Guid context);
 [PreserveSig]int GetChannelVolumeLevel(uint channel,out float value);
 [PreserveSig]int GetChannelVolumeLevelScalar(uint channel,out float value);
 [PreserveSig]int SetMute([MarshalAs(UnmanagedType.Bool)]bool muted,ref Guid context);
 [PreserveSig]int GetMute([MarshalAs(UnmanagedType.Bool)]out bool muted);
 [PreserveSig]int GetVolumeStepInfo(out uint step,out uint count);
 [PreserveSig]int VolumeStepUp(ref Guid context);
 [PreserveSig]int VolumeStepDown(ref Guid context);
 [PreserveSig]int QueryHardwareSupport(out uint mask);
 [PreserveSig]int GetVolumeRange(out float minimum,out float maximum,out float increment);
}
[StructLayout(LayoutKind.Sequential)] struct VolumePropertyKey {public Guid Format;public uint Id;}
[StructLayout(LayoutKind.Sequential)] struct VolumeNotification {public Guid Context;public int Muted;public float Scalar;public uint Channels;}
[ComVisible(true),Guid("657804FA-D6AD-4496-8A60-352752AF4F89"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IVolumeCallback {[PreserveSig]int OnNotify(IntPtr notification);}
[ComVisible(true),Guid("7991EEC9-7E89-4D85-8390-6C703CEC60C0"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IVolumeDeviceNotify {
 [PreserveSig]int OnDeviceStateChanged([MarshalAs(UnmanagedType.LPWStr)]string id,uint state);
 [PreserveSig]int OnDeviceAdded([MarshalAs(UnmanagedType.LPWStr)]string id);
 [PreserveSig]int OnDeviceRemoved([MarshalAs(UnmanagedType.LPWStr)]string id);
 [PreserveSig]int OnDefaultDeviceChanged(int flow,int role,[MarshalAs(UnmanagedType.LPWStr)]string id);
 [PreserveSig]int OnPropertyValueChanged([MarshalAs(UnmanagedType.LPWStr)]string id,VolumePropertyKey key);
}
[ComVisible(true),ClassInterface(ClassInterfaceType.None)]
class VolumeCallback : IVolumeCallback {
 readonly Action<int,bool> receive;
 public VolumeCallback(Action<int,bool> receive){this.receive=receive;}
 public int OnNotify(IntPtr pointer){try{var n=(VolumeNotification)Marshal.PtrToStructure(pointer,typeof(VolumeNotification));receive(Math.Max(0,Math.Min(100,(int)Math.Round(n.Scalar*100))),n.Muted!=0);}catch{}return 0;}
}
[ComVisible(true),ClassInterface(ClassInterfaceType.None)]
class VolumeDeviceNotify : IVolumeDeviceNotify {
 readonly Action changed;
 public VolumeDeviceNotify(Action changed){this.changed=changed;}
 public int OnDeviceStateChanged(string id,uint state){changed();return 0;}
 public int OnDeviceAdded(string id){return 0;}
 public int OnDeviceRemoved(string id){changed();return 0;}
 public int OnDefaultDeviceChanged(int flow,int role,string id){if(flow==0&&role==1)changed();return 0;}
 public int OnPropertyValueChanged(string id,VolumePropertyKey key){return 0;}
}
public static class RainySystemVolume {
 [DllImport("ole32.dll")]static extern int CoInitializeEx(IntPtr reserved,uint model);
 [DllImport("ole32.dll")]static extern void CoUninitialize();
 static void Check(int hr){Marshal.ThrowExceptionForHR(hr);}
 static void Release(object value){if(value!=null&&Marshal.IsComObject(value))Marshal.ReleaseComObject(value);}
 public static void Run(bool watch,int exitAfterMs){
  Check(CoInitializeEx(IntPtr.Zero,0));IVolumeDeviceEnumerator enumerator=null;IVolumeDevice device=null;IVolumeEndpoint endpoint=null;VolumeCallback callback=null;VolumeDeviceNotify notify=null;
  object gate=new object();int rebind=1,stop=0,level=0;bool muted=false,pending=false,registered=false;long bindAt=0;var clock=System.Diagnostics.Stopwatch.StartNew();
  Action<int,bool> receive=(v,m)=>{lock(gate){level=v;muted=m;pending=true;}};
  Action unbind=()=>{if(endpoint!=null&&callback!=null){try{endpoint.UnregisterControlChangeNotify(callback);}catch{}}Release(endpoint);Release(device);endpoint=null;device=null;callback=null;};
  try{
   enumerator=(IVolumeDeviceEnumerator)new VolumeDeviceEnumerator();
   if(watch){notify=new VolumeDeviceNotify(()=>Interlocked.Exchange(ref rebind,1));Check(enumerator.RegisterEndpointNotificationCallback(notify));registered=true;
    var input=new Thread(()=>{try{while(Console.ReadLine()!=null){}}catch{}Interlocked.Exchange(ref stop,1);});input.IsBackground=true;input.Start();}
   while(Volatile.Read(ref stop)==0){
    long now=clock.ElapsedMilliseconds;
    if((Volatile.Read(ref rebind)!=0||endpoint==null)&&now>=bindAt){
     Interlocked.Exchange(ref rebind,0);unbind();bindAt=now+250;
     try{
      Check(enumerator.GetDefaultAudioEndpoint(0,1,out device));Guid iid=typeof(IVolumeEndpoint).GUID;object value;Check(device.Activate(ref iid,23,IntPtr.Zero,out value));endpoint=(IVolumeEndpoint)value;
      if(watch){callback=new VolumeCallback(receive);Check(endpoint.RegisterControlChangeNotify(callback));}
      float scalar;bool isMuted;Check(endpoint.GetMasterVolumeLevelScalar(out scalar));Check(endpoint.GetMute(out isMuted));lock(gate){level=Math.Max(0,Math.Min(100,(int)Math.Round(scalar*100)));muted=isMuted;pending=false;}
      Console.WriteLine("{\"event\":\"volume\",\"initial\":true,\"level\":"+level+",\"muted\":"+(muted?"true":"false")+"}");Console.Out.Flush();
     }catch{unbind();bindAt=now+2000;Console.WriteLine("{\"event\":\"error\",\"message\":\"Default playback volume unavailable\"}");Console.Out.Flush();}
    }
    lock(gate){if(pending){pending=false;Console.WriteLine("{\"event\":\"volume\",\"initial\":false,\"level\":"+level+",\"muted\":"+(muted?"true":"false")+"}");Console.Out.Flush();}}
    if(!watch||exitAfterMs>0&&now>=exitAfterMs)break;Thread.Sleep(15);
   }
  }finally{unbind();if(registered)try{enumerator.UnregisterEndpointNotificationCallback(notify);}catch{}Release(enumerator);CoUninitialize();}
 }
}
'@
[RainySystemVolume]::Run([bool]$Watch,$ExitAfterMs)
