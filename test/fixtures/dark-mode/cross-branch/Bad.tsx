export function Bad({ flag }: { flag: boolean }) {
  return <div className={flag ? "border-blue-400" : "border-gray-200 dark:border-gray-700"} />;
}
