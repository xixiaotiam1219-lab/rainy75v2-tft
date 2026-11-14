# SPDX-License-Identifier: MIT
param([switch]$Watch)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
$null=[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties,Windows.Media.Control,ContentType=WindowsRuntime]
$asTask=[System.WindowsRuntimeSystemExtensions].GetMethods()|Where-Object {$_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'}|Select-Object -First 1
function Await($op,$type){$task=$asTask.MakeGenericMethod($type).Invoke($null,@($op));if(-not $task.Wait(4000)){throw 'Media request timed out'};return $task.Result}
$manager=Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
do {
 $sessions=@();$processes=@();$selected=$manager.GetCurrentSession();$current=$(if($selected){$selected.SourceAppUserModelId}else{''})
 foreach($name in @('cloudmusic','QQMusic')){
  $instances=@();foreach($process in @(Get-Process -Name $name -ErrorAction SilentlyContinue)){try{$instances+=@{pid=$process.Id;startedAt=([DateTimeOffset]$process.StartTime).ToUnixTimeMilliseconds()}}catch{}}
  $processes+=@{source="$name.exe";instances=$instances}
 }
 foreach($session in $manager.GetSessions()){
  $source=$session.SourceAppUserModelId;if($source -notmatch '(?i)qqmusic|cloudmusic|netease'){continue}
  try{$p=Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]);$t=$session.GetTimelineProperties();$at=$t.LastUpdatedTime.ToUnixTimeMilliseconds();$sessions+=@{source=$source;current=($source -eq $current);title=$p.Title;artist=$p.Artist;albumTitle=$p.AlbumTitle;albumArtist=$p.AlbumArtist;status=$session.GetPlaybackInfo().PlaybackStatus.ToString();positionMs=[Math]::Max(0,($t.Position-$t.StartTime).TotalMilliseconds);durationMs=[Math]::Max(0,($t.EndTime-$t.StartTime).TotalMilliseconds);positionAt=$(if($at -gt 0){$at}else{$null});observedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}}catch{}
 }
 [Console]::WriteLine((ConvertTo-Json -InputObject @{sessions=@($sessions);processes=@($processes)} -Depth 6 -Compress));[Console]::Out.Flush()
 if($Watch){Start-Sleep -Milliseconds 1000}
}while($Watch)
