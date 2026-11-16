# SPDX-License-Identifier: MIT
param([ValidateSet('Enable','Disable')][string]$Action,[string]$DataDirectory,[string]$StartupDirectory)
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if(-not $DataDirectory){
 $portableRuntime=Join-Path $project '..\runtime\node.exe'
 if(Test-Path -LiteralPath $portableRuntime){$DataDirectory=[IO.Path]::GetFullPath((Join-Path $project '..\data'))}
 else{$DataDirectory=Join-Path $project 'local/lyrics'}
}
$state=Join-Path $DataDirectory 'background-runtime.json'
if($StartupDirectory){$folder=$StartupDirectory}
elseif($env:RAINY75_STARTUP_DIR){$folder=$env:RAINY75_STARTUP_DIR}
else{$folder=[Environment]::GetFolderPath('Startup')}
if(-not $folder){throw 'Current-user Startup folder is unavailable'}
$entry=Join-Path $folder 'Rainy75V2-TFT-Lyrics.vbs'
if($Action -eq 'Disable'){if(Test-Path -LiteralPath $entry){Remove-Item -LiteralPath $entry};'Disabled';exit}
$runtime=Get-Content -LiteralPath $state -Raw -Encoding UTF8|ConvertFrom-Json
$node=[IO.Path]::GetFullPath($runtime.nodeExecutable)
$launcher=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'launch.cjs'))
if(-not(Test-Path -LiteralPath $node) -or -not(Test-Path -LiteralPath $launcher)){throw 'Background runtime is missing'}
$escape={param($s) $s.Replace('"','""')}
$font=$env:RAINY75_FONT
if(-not $font){$portableFont=Join-Path $project 'FONT.BIN';if(Test-Path -LiteralPath $portableFont){$font=$portableFont}}
$vbs='Set shell = CreateObject("WScript.Shell")'+"`r`n"+'shell.Environment("PROCESS")("RAINY75_DATA") = "'+(& $escape ([IO.Path]::GetFullPath($DataDirectory)))+'"'+"`r`n"
if($font){$vbs+='shell.Environment("PROCESS")("RAINY75_FONT") = "'+(& $escape ([IO.Path]::GetFullPath($font)))+'"'+"`r`n"}
$command='"'+$node+'" "'+$launcher+'"'
$vbs+='shell.Run "'+(& $escape $command)+'", 0, False'+"`r`n"
[IO.Directory]::CreateDirectory($folder)|Out-Null
[IO.File]::WriteAllText($entry,$vbs,[Text.Encoding]::Unicode)
'Enabled for current user'
