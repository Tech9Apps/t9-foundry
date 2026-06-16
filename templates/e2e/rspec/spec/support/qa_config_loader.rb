require 'json'

module QAConfigLoader
  # Load qa-config.json from the QA harness directory.
  #
  # Looks in QA_HARNESS_DIR env var first, then two levels up from spec/support/
  # as a fallback. Adjust the fallback path if your layout differs.
  def self.load
    harness_dir = ENV['QA_HARNESS_DIR']
    config_path = if harness_dir
                    File.join(harness_dir, 'qa-config.json')
                  else
                    File.expand_path('../../../qa-config.json', __dir__)
                  end

    return {} unless File.exist?(config_path)

    JSON.parse(File.read(config_path))
  rescue JSON::ParserError
    {}
  end
end
