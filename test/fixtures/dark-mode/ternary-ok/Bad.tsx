export function Bad({ flag }: { flag: boolean }) {
  return <div className={flag ? "dark:bg-blue-500" : "dark:bg-gray-800"} />;
}
