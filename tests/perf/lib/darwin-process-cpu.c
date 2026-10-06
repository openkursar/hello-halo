#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <mach/mach_time.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <time.h>
#include <unistd.h>

static uint64_t monotonic_ns(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC_RAW, &value) != 0) return 0;
  return (uint64_t)value.tv_sec * 1000000000ULL + (uint64_t)value.tv_nsec;
}

static uint64_t cpu_nanoseconds(uint64_t ticks) {
  mach_timebase_info_data_t ratio;
  mach_timebase_info(&ratio);
  return (uint64_t)(((__uint128_t)ticks * ratio.numer) / ratio.denom);
}

static void sample(pid_t pid) {
  struct proc_bsdinfo before;
  struct proc_bsdinfo after;
  struct rusage_info_v4 usage;
  memset(&usage, 0, sizeof(usage));
  int first = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &before, sizeof(before));
  int result = first == (int)sizeof(before) ? proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&usage) : -1;
  int saved_errno = errno;
  uint64_t sampled_at = monotonic_ns();
  int last = result == 0 ? proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, sizeof(after)) : -1;
  if (first != (int)sizeof(before) || result != 0 || last != (int)sizeof(after) || sampled_at == 0) {
    printf("{\"pid\":%d,\"error\":\"process-read-failed\",\"errno\":%d}", pid, saved_errno);
    return;
  }
  if (before.pbi_start_tvsec != after.pbi_start_tvsec || before.pbi_start_tvusec != after.pbi_start_tvusec) {
    printf("{\"pid\":%d,\"error\":\"pid-reused-during-read\"}", pid);
    return;
  }
  uint64_t started_us = before.pbi_start_tvsec * 1000000ULL + before.pbi_start_tvusec;
  printf("{\"pid\":%d,\"startTimeUs\":\"%" PRIu64 "\",\"sampleTimeNs\":\"%" PRIu64 "\",\"userCpuNs\":\"%" PRIu64 "\",\"systemCpuNs\":\"%" PRIu64 "\"}",
         pid, started_us, sampled_at, cpu_nanoseconds(usage.ri_user_time), cpu_nanoseconds(usage.ri_system_time));
}

int main(int argc, char **argv) {
  mach_timebase_info_data_t ratio;
  mach_timebase_info(&ratio);
  printf("{\"backend\":\"darwin-proc-pid-rusage-v4\",\"clock\":\"CLOCK_MONOTONIC_RAW\",\"cpuUnit\":\"nanoseconds\",\"cpuResolutionNs\":%.9f,\"machTimebase\":{\"numer\":%u,\"denom\":%u},\"samples\":[", (double)ratio.numer / ratio.denom, ratio.numer, ratio.denom);
  if (argc == 2 && strcmp(argv[1], "--probe") == 0) {
    sample(getpid());
    struct timespec pause = {0, 100000000};
    nanosleep(&pause, NULL);
    printf(",");
    sample(getpid());
    uint64_t deadline = monotonic_ns() + 200000000ULL;
    volatile uint64_t work = 0;
    while (monotonic_ns() < deadline) work++;
    printf(",");
    sample(getpid());
  } else {
    for (int index = 1; index < argc; index++) {
      char *end;
      long value = strtol(argv[index], &end, 10);
      if (*end || value < 1 || value > INT32_MAX) return 2;
      if (index > 1) printf(",");
      sample((pid_t)value);
    }
  }
  printf("]}\n");
  return 0;
}
