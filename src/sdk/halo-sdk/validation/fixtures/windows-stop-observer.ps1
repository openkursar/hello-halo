$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
# Hold a read-only handle so a later PID reuse cannot change the object being checked.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class StopObservation {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern SafeWaitHandle OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint WaitForSingleObject(SafeWaitHandle h, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(SafeWaitHandle h, out long created, out long exited, out long kernel, out long user);
  public static bool Predates(SafeWaitHandle h, long marker) {
    long created, exited, kernel, user;
    return GetProcessTimes(h, out created, out exited, out kernel, out user) && created > 0 && created < marker;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool QueryFullProcessImageName(SafeWaitHandle h, uint flags, StringBuilder image, ref uint size);
}
'@
$handles = @{}
try {
  [Console]::WriteLine('{"ready":true}')
  while ($null -ne ($line = [Console]::ReadLine())) {
    $r = $line | ConvertFrom-Json
    if ($r.cmd -eq 'close') { break }
    $states = @()
    foreach ($member in $r.members) {
      $key = [string]$member.key
      $state = 'unknown'
      if ($r.cmd -eq 'bind' -and !$handles.ContainsKey($key)) {
        $h = [StopObservation]::OpenProcess(0x101000, $false, [uint32]$member.pid)
        if (!$h.IsInvalid) {
          $marker = [IO.File]::GetLastWriteTimeUtc([string]$member.marker).ToFileTimeUtc()
          $image = New-Object Text.StringBuilder 32768
          [uint32]$size = $image.Capacity
          if ([StopObservation]::QueryFullProcessImageName($h, 0, $image, [ref]$size) -and
              [IO.Path]::GetFileName($image.ToString()) -ieq $member.image -and
              [StopObservation]::Predates($h, $marker) -and
              [StopObservation]::WaitForSingleObject($h, 0) -eq 258) {
            $handles[$key] = $h
          } else { $h.Dispose() }
        } else { $h.Dispose() }
      }
      if ($handles.ContainsKey($key)) {
        $status = [StopObservation]::WaitForSingleObject($handles[$key], 0)
        if ($status -eq 0) { $state = 'exited' }
        if ($status -eq 258) { $state = 'running' }
      }
      $states += $state
    }
    [Console]::WriteLine((@{id=$r.id; states=@($states)} | ConvertTo-Json -Compress))
  }
} finally {
  foreach ($h in $handles.Values) { $h.Dispose() }
}
